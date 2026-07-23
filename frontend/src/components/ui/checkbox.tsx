import * as React from 'react'
import { Check, Minus } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Checkbox({
  className,
  checked,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={checked}
      className={cn(
        'peer relative size-4 shrink-0 rounded transition-shadow pointer-coarse:size-[44px]',
        "before:absolute before:left-1/2 before:top-1/2 before:size-4 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded before:border before:border-input before:shadow-xs before:content-['']",
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'data-[state=checked]:text-primary-foreground data-[state=checked]:before:border-primary data-[state=checked]:before:bg-primary',
        'data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:before:border-primary data-[state=indeterminate]:before:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="relative z-10 flex size-full items-center justify-center text-current">
        {checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={2.5} />
        ) : (
          <Check className="size-3" strokeWidth={2.5} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
