import Link from "next/link";

/**
 * The app's one navigation.
 *
 * It used to be hand-written in five page files, and they drifted: `/corrections` was reachable
 * only from the dashboard, `/history` had no link to the plan, and each page offered a different
 * subset in a different order. A merchant never got to learn where anything was. One list, one
 * order, every page — so the next destination added lands everywhere at once.
 *
 * The current page is marked twice on purpose. `aria-current` alone was already there and told a
 * screen reader where it stood, while the styling was identical on every link, so a sighted
 * merchant looking at five identical pills had no idea which one they were on.
 */

export const APP_NAV_ITEMS = [
  { href: "/", label: "Ürün Sağlığı" },
  { href: "/corrections", label: "Düzeltmeler" },
  { href: "/history", label: "Geçmiş" },
  { href: "/settings", label: "Ayarlar" },
  { href: "/plan", label: "Plan" },
] as const;

export type AppNavHref = (typeof APP_NAV_ITEMS)[number]["href"];

/**
 * Font weight is part of the shared base, not the active state.
 *
 * Marking the current tab bold changed its text width, so the menu visibly reflowed from page to
 * page — the widest label happened to be the dashboard's, which made it look like a different
 * control. The current page is carried by colour, border and fill instead, none of which change
 * how much room a label takes.
 */
const BASE =
  "inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function AppNav({ current }: { current: AppNavHref }) {
  return (
    <nav aria-label="Ana navigasyon" className="flex flex-wrap gap-2">
      {APP_NAV_ITEMS.map((item) => {
        const active = item.href === current;

        return (
          <Link
            className={
              active
                ? `${BASE} border-accent bg-accent-soft text-accent`
                : `${BASE} border-border-strong bg-surface text-text hover:bg-surface-sunken`
            }
            href={item.href}
            key={item.href}
            {...(active ? { "aria-current": "page" as const } : {})}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
