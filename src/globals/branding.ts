/**
 * The app's own name, in one place.
 *
 * It used to be spelled out at a dozen call sites, which meant a rename touched twelve files and
 * could half-land. The split matters: `APP_FULL_NAME` answers "which app is this" and belongs on
 * the surfaces a merchant might arrive at cold — the browser tab, the setup and error screens.
 * `APP_SECTION_NAME` is the dashboard's own name and belongs in navigation, where the full brand
 * would read badly ("TEMEL | Ürün Sağlığı Asistanına dön").
 */

export const APP_BRAND = "TEMEL";
export const APP_NAME = "Ürün Sağlığı Asistanı";
export const APP_FULL_NAME = `${APP_BRAND} | ${APP_NAME}`;

/** The dashboard as a destination, not the product as a whole. */
export const APP_SECTION_NAME = "Ürün Sağlığı";
