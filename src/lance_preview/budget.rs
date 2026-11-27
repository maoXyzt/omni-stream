//! Lance returns fully decoded Arrow buffers, including for one-row reads.
//! Meter live Rust allocations across decoder threads in the disposable Data
//! worker. The server and Schema path always use the system allocator directly.
use std::{
  alloc::{GlobalAlloc, Layout, System},
  cell::Cell,
  collections::HashSet,
  ptr,
  sync::{Mutex, OnceLock},
};

pub(super) const EXCEEDED: i32 = 75;
static LIVE: OnceLock<Mutex<Live>> = OnceLock::new();
#[derive(Default)]
struct Live {
  bytes: usize,
  pointers: HashSet<usize>,
}

thread_local! {
  // Formatting a decoded page uses the separate display budget.
  static FORMATTING: Cell<bool> = const { Cell::new(false) };
  // The table itself uses System via the recursive allocator call.
  static BOOKKEEPING: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn enable() {
  LIVE.get_or_init(Default::default);
}

pub(super) fn format_output<T>(f: impl FnOnce() -> T) -> T {
  struct Restore<'a>(&'a Cell<bool>, bool);
  impl Drop for Restore<'_> {
    fn drop(&mut self) {
      self.0.set(self.1);
    }
  }
  FORMATTING.with(|flag| {
    let _restore = Restore(flag, flag.replace(true));
    f()
  })
}

fn stop() -> ! {
  // The worker may be inside the allocator with its accounting lock held.
  // Skip exit handlers (which may themselves allocate).
  unsafe extern "C" {
    fn _exit(code: std::ffi::c_int) -> !;
  }
  unsafe { _exit(EXCEEDED) }
}

struct WorkerAllocator;

#[global_allocator]
static ALLOCATOR: WorkerAllocator = WorkerAllocator;

impl WorkerAllocator {
  fn allocate(size: usize, allocate: impl FnOnce() -> *mut u8) -> *mut u8 {
    let Some(live) = LIVE.get() else {
      return allocate();
    };
    if FORMATTING.get() || BOOKKEEPING.get() {
      return allocate();
    }
    BOOKKEEPING.with(|busy| {
      busy.set(true);
      let Ok(mut live) = live.lock() else { stop() };
      // Bound the pointer table as well as the allocations it tracks.
      if size > super::DISPLAY_BYTES - live.bytes || live.pointers.len() >= 65536 {
        stop();
      }
      if live.pointers.try_reserve(1).is_err() {
        stop()
      }
      let p = allocate();
      if !p.is_null() {
        live.pointers.insert(p as usize);
        live.bytes += size;
      }
      drop(live);
      busy.set(false);
      p
    })
  }
}

// SAFETY: All pointers and layouts are passed unchanged to System. Tracking
// is enabled once per worker and never changes allocation layout or alignment.
unsafe impl GlobalAlloc for WorkerAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    Self::allocate(layout.size(), || unsafe { System.alloc(layout) })
  }
  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    Self::allocate(layout.size(), || unsafe { System.alloc_zeroed(layout) })
  }
  unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
    if let Some(live) = LIVE.get() {
      // A second TLS flag distinguishes recursive hash-table operations from
      // JSON formatting, which may legitimately release charged buffers.
      BOOKKEEPING.with(|busy| {
        if !busy.get() {
          busy.set(true);
          let Ok(mut live) = live.lock() else { stop() };
          if live.pointers.remove(&(p as usize)) {
            live.bytes -= layout.size();
          }
          busy.set(false);
        }
      });
    }
    unsafe { System.dealloc(p, layout) }
  }
  unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
    if LIVE.get().is_none() || BOOKKEEPING.get() {
      return unsafe { System.realloc(p, old, size) };
    }
    let Ok(new) = Layout::from_size_align(size, old.align()) else {
      return ptr::null_mut();
    };
    let next = unsafe { self.alloc(new) };
    if !next.is_null() {
      unsafe {
        ptr::copy_nonoverlapping(p, next, old.size().min(size));
        self.dealloc(p, old);
      }
    }
    next
  }
}
