import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const surfaceColors = [
  { name: "background", cssVar: "--background", className: "bg-background" },
  { name: "card", cssVar: "--card", className: "bg-card" },
  { name: "popover", cssVar: "--popover", className: "bg-popover" },
  { name: "input", cssVar: "--input", className: "bg-input" },
  { name: "border", cssVar: "--border", className: "bg-background border border-border" },
] as const;

const accentColors = [
  { name: "primary", cssVar: "--primary", className: "bg-primary" },
  { name: "focus ring", cssVar: "--ring", className: "bg-ring" },
  {
    name: "primary-foreground",
    cssVar: "--primary-foreground",
    className: "bg-primary-foreground text-primary",
  },
  { name: "destructive", cssVar: "--destructive", className: "bg-destructive" },
  { name: "muted", cssVar: "--muted", className: "bg-muted" },
] as const;

const statusColors = [
  { name: "working", cssVar: "--color-status-working" },
  { name: "compacting", cssVar: "--color-status-compacting" },
  { name: "success", cssVar: "--color-status-success" },
  { name: "warning", cssVar: "--color-status-warning" },
  { name: "error", cssVar: "--color-status-error" },
] as const;

function useCssVarValues(cssVars: readonly string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const v of cssVars) {
      next[v] = style.getPropertyValue(v).trim().toUpperCase() || v;
    }
    setValues(next);
  }, [cssVars]);
  return values;
}

const typographySamples = [
  { className: "text-3xl font-bold", label: "Heading 3XL (30px) -- font-sans" },
  { className: "text-2xl font-semibold", label: "Heading 2XL (24px) -- font-sans" },
  { className: "text-xl font-medium", label: "Heading XL (20px) -- font-sans" },
  {
    className: "text-base",
    label: "Body text (16px) -- The quick brown fox jumps over the lazy dog. -- font-sans",
  },
  { className: "text-sm text-muted-foreground", label: "Small muted text (14px) -- font-sans" },
] as const;

const spacingSteps = [
  { className: "w-1", label: "w-1 (4px)" },
  { className: "w-2", label: "w-2 (8px)" },
  { className: "w-3", label: "w-3 (12px)" },
  { className: "w-4", label: "w-4 (16px)" },
  { className: "w-6", label: "w-6 (24px)" },
  { className: "w-8", label: "w-8 (32px)" },
  { className: "w-12", label: "w-12 (48px)" },
  { className: "w-16", label: "w-16 (64px)" },
] as const;

const radiusSteps = [
  { className: "rounded-sm", label: "sm (2px)" },
  { className: "rounded-md", label: "md (4px)" },
  { className: "rounded-lg", label: "lg (6px)" },
  { className: "rounded-xl", label: "xl (8px)" },
] as const;

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-semibold border-b border-border pb-2">{children}</h2>;
}

function ColorSwatch({ className, label }: { className: string; label: string }) {
  return (
    <div>
      <div className={`h-20 rounded-md border border-border ${className}`} />
      <p className="text-sm text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

const allCssVars = [
  ...surfaceColors.map((c) => c.cssVar),
  ...accentColors.map((c) => c.cssVar),
  "--muted-foreground",
  ...statusColors.map((c) => c.cssVar),
];

export function TokenShowcase() {
  const vars = useCssVarValues(allCssVars);

  return (
    <div className="min-h-screen p-3 sm:p-4 lg:p-6">
      <div className="max-w-4xl mx-auto space-y-8">
        <h1 className="text-3xl font-bold text-primary">Token Showcase</h1>

        {/* Color Palette */}
        <section className="space-y-4">
          <SectionHeader>Color Palette</SectionHeader>

          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Surface Hierarchy
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {surfaceColors.map((c) => (
              <ColorSwatch
                key={c.name}
                className={c.className}
                label={`${vars[c.cssVar] ?? c.cssVar} / ${c.name}`}
              />
            ))}
          </div>

          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-6">
            Accent & Semantic
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {accentColors.map((c) => (
              <ColorSwatch
                key={c.name}
                className={c.className}
                label={`${vars[c.cssVar] ?? c.cssVar} / ${c.name}`}
              />
            ))}
            <div>
              <div className="h-20 rounded-md border border-border bg-background flex items-center justify-center">
                <span className="text-muted-foreground">{vars["--muted-foreground"] ?? "—"}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {vars["--muted-foreground"] ?? "—"} / muted-foreground
              </p>
            </div>
          </div>

          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-6">
            Status Colors
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {statusColors.map((c) => (
              <div key={c.name}>
                <div
                  className="h-20 rounded-md border border-border"
                  style={{ backgroundColor: `var(${c.cssVar})` }}
                />
                <p className="text-sm text-muted-foreground mt-1">
                  {vars[c.cssVar] ?? c.cssVar} / {c.name}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Typography */}
        <section className="space-y-4">
          <SectionHeader>Typography</SectionHeader>
          <div className="space-y-3">
            {typographySamples.map((s) => (
              <div key={s.label}>
                <p className={s.className}>{s.label}</p>
              </div>
            ))}
          </div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-6">
            Monospace (Sarasa Fixed SC)
          </h3>
          <div className="space-y-2 bg-card p-3 rounded-md border border-border">
            <p className="text-base font-mono">{"const greeting = 'Hello'; // Sarasa Fixed SC"}</p>
            <p className="text-base font-mono">{"const msg = '----'; // CJK alignment test"}</p>
          </div>
        </section>

        {/* Spacing */}
        <section className="space-y-4">
          <SectionHeader>Spacing</SectionHeader>
          <div className="space-y-2">
            {spacingSteps.map((s) => (
              <div key={s.label} className="flex items-center gap-3">
                <div className={`${s.className} h-3 bg-primary rounded-sm`} />
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Border Radius */}
        <section className="space-y-4">
          <SectionHeader>Border Radius</SectionHeader>
          <div className="flex flex-wrap gap-4">
            {radiusSteps.map((r) => (
              <div key={r.label} className="text-center">
                <div className={`w-16 h-16 bg-card border border-border ${r.className}`} />
                <p className="text-xs text-muted-foreground mt-1">{r.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Button Variants */}
        <section className="space-y-4">
          <SectionHeader>Button Variants</SectionHeader>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Variants
          </h3>
          <div className="flex flex-wrap gap-3">
            <Button>Default</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
          </div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-4">
            Sizes
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon">
              <span>+</span>
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
