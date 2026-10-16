/**
 * Whether this visitor needs an analytics consent prompt (components/analytics/ConsentBanner).
 *
 * The country comes from Vercel's edge (`x-vercel-ip-country`), so no IP lookup happens here and
 * nothing is stored. A separate route rather than a header read in a page, so every page stays
 * static and ISR keeps working. Unknown country (local dev, header missing) counts as needing
 * consent: asking when we didn't have to is the safe mistake.
 */
export const dynamic = "force-dynamic";

// EU member states, the rest of the EEA, the UK and Switzerland.
const CONSENT_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
]);

export function GET(request: Request) {
  const country = (request.headers.get("x-vercel-ip-country") || "").toUpperCase() || null;
  const consentRequired = !country || CONSENT_COUNTRIES.has(country);
  return Response.json(
    { country, consentRequired },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
