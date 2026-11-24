<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			// Durable Runner's buttons, in one place: every page uses these, never per-instance colours.
			variant: {
				// the brand button: vermilion with a top highlight and glow (btn-brand in app.css)
				default: "btn-brand",
				// secondary: card surface, hairline edge
				outline: "border-[var(--c-line-strong)] bg-card text-ink hover:bg-[var(--c-hover)] aria-expanded:bg-[var(--c-hover)]",
				// quiet icon actions (the theme toggle)
				ghost: "text-ink hover:bg-[var(--c-hover)] aria-expanded:bg-[var(--c-hover)]",
				secondary: "bg-[var(--c-hover)] text-ink hover:bg-[var(--c-line)]",
				destructive: "bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 text-destructive",
				link: "text-ink underline-offset-4 hover:underline",
			},
			size: {
				// the call to action: header, cards, sections, 404
				default: "h-11 gap-2 rounded-[14px] pl-[15px] pr-[17px] text-[15px] font-[520] tracking-[-0.005em] [&_svg:not([class*='size-'])]:size-[17px]",
				sm: "h-9 gap-1.5 rounded-[11px] px-3.5 text-[14px] font-[520] [&_svg:not([class*='size-'])]:size-4",
				// square icon buttons: 40 px (header) and 38 px (card arrows)
				icon: "size-10 rounded-[12px] [&_svg:not([class*='size-'])]:size-[17px]",
				"icon-sm": "size-[38px] rounded-[11px] [&_svg:not([class*='size-'])]:size-[13px]",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
