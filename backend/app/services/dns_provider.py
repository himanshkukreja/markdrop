"""Who runs the DNS for this domain, and how to tell them apart.

One-click DNS setup is a paid toll: GoDaddy and IONOS stopped onboarding Domain
Connect templates from service providers and now route everyone through Entri,
which starts at $249/month. Between them that is roughly a quarter of .com.

The free thing that actually helps is smaller and duller: work out which control
panel the customer is about to open, then give them that panel's words. "Add a
CNAME with Host `docs`" is useless at a provider whose field is called Name and
which wants the full hostname; naming the provider, linking straight to its DNS
page and using its own vocabulary removes most of the failures we would
otherwise see, and costs nothing.

Detection is by nameserver, not by registrar. Those are different things and the
nameserver is the one that matters -- a domain bought at GoDaddy but pointed at
Cloudflare is edited in Cloudflare, and telling that customer to look in GoDaddy
sends them somewhere with no DNS records in it at all.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Provider:
    id: str
    name: str
    # Deep link to the DNS editor. `{domain}` is substituted where the provider
    # accepts a domain in the path or query; otherwise it's the panel root.
    url: str
    # What this provider calls the field we mean by "name".
    host_field: str
    # Whether it wants the sub-part only ("docs") or the whole hostname.
    wants_relative: bool
    note: str = ""
    # What this provider calls the field we mean by "value" (the CNAME's target).
    value_field: str = "Value"
    # Other fields its form asks for, with what to choose: ((label, value), ...).
    extras: tuple[tuple[str, str], ...] = ()


# Matched against the nameserver hostname by suffix. Ordered most specific
# first, since several providers share a parent domain.
_BY_NAMESERVER: list[tuple[str, Provider]] = [
    ("domaincontrol.com", Provider(
        "godaddy", "GoDaddy",
        "https://dcc.godaddy.com/control/{domain}/dns",
        "Name", True,
        "GoDaddy appends the domain for you — enter just the sub-part, not the full hostname.",
        "Value", (("TTL", "1 Hour"),))),
    ("ns.cloudflare.com", Provider(
        "cloudflare", "Cloudflare",
        "https://dash.cloudflare.com/?to=/:account/{domain}/dns",
        "Name", True,
        "Set Proxy status to DNS only (grey cloud) — an orange cloud breaks certificate issuance.",
        "Target", (("Proxy status", "DNS only (grey cloud)"),))),
    ("registrar-servers.com", Provider(
        "namecheap", "Namecheap",
        "https://ap.www.namecheap.com/domains/domaincontrolpanel/{domain}/advancedns",
        "Host", True,
        "Use the Advanced DNS tab, not Domain > Redirect.",
        "Value", (("TTL", "Automatic"),))),
    ("awsdns", Provider(
        "route53", "AWS Route 53",
        "https://console.aws.amazon.com/route53/v2/hostedzones",
        "Record name", True)),
    ("ui-dns.", Provider(
        "ionos", "IONOS",
        "https://my.ionos.com/domains", "Host name", True)),
    ("ionos.", Provider(
        "ionos", "IONOS",
        "https://my.ionos.com/domains", "Host name", True)),
    ("googledomains.com", Provider(
        "squarespace", "Squarespace Domains",
        "https://account.squarespace.com/domains", "Host", True,
        "Google Domains moved to Squarespace — sign in with the same account.")),
    ("dns-parking.com", Provider(
        "hostinger", "Hostinger",
        "https://hpanel.hostinger.com/domain", "Name", True, value_field="Target")),
    ("digitalocean.com", Provider(
        "digitalocean", "DigitalOcean",
        "https://cloud.digitalocean.com/networking/domains", "Hostname", True, value_field="Is an alias of")),
    ("vercel-dns.com", Provider(
        "vercel", "Vercel",
        "https://vercel.com/dashboard/domains", "Name", True)),
    ("nsone.net", Provider("ns1", "NS1", "https://my.nsone.net/", "Name", True)),
    ("azure-dns", Provider(
        "azure", "Azure DNS",
        "https://portal.azure.com/#browse/Microsoft.Network%2FdnsZones", "Name", True)),
    ("name.com", Provider(
        "namecom", "Name.com",
        "https://www.name.com/account/domain/details/{domain}#dns", "Host", True)),
    ("porkbun.com", Provider(
        "porkbun", "Porkbun",
        "https://porkbun.com/account/domainsSpeedy", "Host", True, value_field="Answer")),
    ("bigrock", Provider(
        "bigrock", "BigRock",
        "https://manage.bigrock.in/", "Host Name", True)),
    ("resellerclub", Provider(
        "resellerclub", "ResellerClub",
        "https://manage.resellerclub.com/", "Host Name", True)),
    ("hover.com", Provider(
        "hover", "Hover", "https://www.hover.com/control_panel/domains", "Hostname", True)),
    ("gandi.net", Provider(
        "gandi", "Gandi", "https://admin.gandi.net/domain", "Name", True)),
    ("dnsimple.com", Provider(
        "dnsimple", "DNSimple", "https://dnsimple.com/dashboard", "Name", True)),
    ("wixdns.net", Provider(
        "wix", "Wix", "https://www.wix.com/my-account/domains", "Host Name", True)),
    ("bluehost.com", Provider(
        "bluehost", "Bluehost", "https://my.bluehost.com/hosting/app", "Host Record", True)),
    ("hostgator", Provider(
        "hostgator", "HostGator", "https://portal.hostgator.com/", "Host Record", True)),
    ("dreamhost.com", Provider(
        "dreamhost", "DreamHost", "https://panel.dreamhost.com/index.cgi?tree=domain.manage",
        "Name", True)),
    ("zoho", Provider("zoho", "Zoho", "https://mail.zoho.com/cpanel/index.do", "Name", True)),
    ("netlify.com", Provider(
        "netlify", "Netlify", "https://app.netlify.com/teams/dns", "Name", True)),
    ("registrar.amazon", Provider(
        "route53", "AWS Route 53",
        "https://console.aws.amazon.com/route53/v2/hostedzones", "Record name", True)),
]


def _match(nameservers: list[str]) -> Provider | None:
    for ns in nameservers:
        low = ns.lower().rstrip(".")
        for needle, provider in _BY_NAMESERVER:
            if needle in low:
                return provider
    return None


def nameservers_for(host: str) -> list[str]:
    """The authoritative nameservers for the zone holding ``host``.

    Synchronous (dnspython is), so callers must push it through a threadpool.
    Returns an empty list on any failure -- an unknown provider degrades to the
    generic instructions, which is the same thing every customer sees today.
    """
    try:
        import dns.name
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 5.0
        resolver.timeout = 5.0
        zone = dns.resolver.zone_for_name(dns.name.from_text(host), resolver=resolver)
        return [str(ns.target) for ns in resolver.resolve(zone, "NS")]
    except Exception:
        return []


def zone_of(host: str, nameservers_known: bool = True) -> str:
    """The registrable zone, which is what a provider's panel is keyed on."""
    parts = host.rstrip(".").split(".")
    if len(parts) <= 2:
        return host
    # Two labels is right for .com and friends, three for the common
    # second-level suffixes (.co.uk, .com.au, .co.in) that would otherwise be
    # cut in half.
    if len(parts) >= 3 and parts[-2] in {"co", "com", "net", "org", "gov", "ac"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def detect(host: str) -> tuple[Provider | None, list[str]]:
    """(provider, nameservers). Provider is None when we don't recognise them."""
    nameservers = nameservers_for(host)
    return _match(nameservers), nameservers


# ── Shared by every custom-domain screen (workspace domains, a guide's own domain) ──


def zone_for(host: str) -> str:
    """The zone that actually holds ``host`` (an SOA lookup), else :func:`zone_of`'s guess.

    Synchronous; through a threadpool. The lookup matters for names under a delegated
    sub-zone (``help.eu.acme.com`` with ``eu.acme.com`` hosted elsewhere): the panel to
    open, Domain Connect's discovery and the relative name are all the sub-zone's.
    """
    try:
        import dns.name
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 5.0
        resolver.timeout = 5.0
        zone = str(dns.resolver.zone_for_name(dns.name.from_text(host), resolver=resolver)).rstrip(".").lower()
        if "." in zone and (host == zone or host.endswith("." + zone)):
            return zone
    except Exception:
        pass
    return zone_of(host)


def relative_name(name: str, zone: str, provider: Provider | None) -> str:
    """``name`` the way ``provider``'s form wants it typed: without the zone where the panel
    appends it (``help`` for ``help.acme.com``, ``@`` for the zone itself); unchanged for a
    panel that takes the whole hostname, or when the provider is unknown."""
    name = name.rstrip(".")
    if provider is None or not provider.wants_relative:
        return name
    if name == zone:
        return "@"
    return name[: -(len(zone) + 1)] if name.endswith("." + zone) else name


def hint(host: str, names: dict[str, str], *, zone: str | None = None,
         found: tuple[Provider | None, list[str]] | None = None) -> dict:
    """Who runs ``host``'s DNS, and the given record names as their panel wants them typed.

    ``names`` maps a key to a full record name ({"target": "help.acme.com"}); the answer's
    ``names`` has the same keys, relative where the panel appends the zone. Synchronous
    (DNS lookups unless ``zone`` and ``found`` are given): call it through a threadpool.
    """
    provider, nameservers = found if found is not None else detect(host)
    zone = zone or (zone_for(host) if provider is not None else zone_of(host))
    if provider is None:
        return {"detected": False, "zone": zone, "nameservers": nameservers[:4],
                "names": {k: v.rstrip(".") for k, v in names.items()}}
    return {
        "detected": True,
        "zone": zone,
        "provider_id": provider.id,
        "provider_name": provider.name,
        "panel_url": provider.url.replace("{domain}", zone),
        "host_field": provider.host_field,
        "value_field": provider.value_field,
        "extras": [{"label": k, "value": v} for k, v in provider.extras],
        "note": provider.note or None,
        "nameservers": nameservers[:4],
        "names": {k: relative_name(v, zone, provider) for k, v in names.items()},
    }


def cname_of(host: str) -> str | None:
    """Where ``host``'s CNAME points right now: the target, "" when it has none, None when DNS
    didn't answer. Synchronous: call it through a threadpool."""
    try:
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4.0
        resolver.timeout = 4.0
        answer = resolver.resolve(host, "CNAME")
        return str(answer[0].target).rstrip(".").lower()
    except Exception as exc:  # NXDOMAIN / NoAnswer: there is none; anything else: unknown
        return "" if type(exc).__name__ in ("NXDOMAIN", "NoAnswer") else None
