"""Custom domains for a workspace.

Adding a domain proves nothing on its own. A host only ever influences what
anyone is served once its `_markdrop-verify` TXT record has been seen, because
otherwise anyone could claim a hostname they don't control.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.domain import Domain
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.domain import (
    DnsProviderHint,
    DomainCreate,
    DomainListResponse,
    DomainResponse,
    HostResolution,
)
from app.services import dns_provider as dns_provider_service
from app.services import domain as domain_service
from app.services import workspace as ws_service

settings = get_settings()
router = APIRouter(prefix="/api/v1", tags=["domains"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _is_apex(host: str) -> bool:
    """Rough but adequate: an apex has no subdomain label to CNAME."""
    return host.count(".") == 1


def _warning_for(domain: Domain) -> str | None:
    if domain.kind != "cdn":
        return None
    return (
        "This host will serve files uploaded by your users. Anything it serves can "
        "set cookies on its parent domain, so prefer a domain you use for nothing "
        "else — not one that also hosts your app or marketing site."
    )


def _to_response(domain: Domain) -> DomainResponse:
    apex = _is_apex(domain.host)
    return DomainResponse(
        id=domain.id,
        host=domain.host,
        kind=domain.kind,
        status=domain.status,
        created_at=domain.created_at,
        verified_at=domain.verified_at,
        last_checked_at=domain.last_checked_at,
        last_error=domain.last_error,
        attached=domain.attached,
        dns_record_name=f"{domain_service.TXT_PREFIX}.{domain.host}",
        dns_record_value=domain.verification_token,
        dns_target_name=domain.host,
        dns_target_type="A" if apex else "CNAME",
        dns_target_value=(
            settings.custom_domain_apex_ip if apex else settings.custom_domain_cname_target
        ),
        warning=_warning_for(domain),
    )


@router.get("/workspaces/{workspace_id}/domains", response_model=DomainListResponse)
@limiter.limit("120/minute")
async def list_domains(
    request: Request,
    workspace_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    domains = await domain_service.list_domains(db, workspace_id)
    return DomainListResponse(domains=[_to_response(d) for d in domains])


@router.post("/workspaces/{workspace_id}/domains", response_model=DomainResponse, status_code=201)
@limiter.limit("20/minute")
async def add_domain(
    request: Request,
    workspace_id: str,
    data: DomainCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    domain = await domain_service.add_domain(db, workspace_id, data.host, data.kind)
    return _to_response(domain)


@router.post(
    "/workspaces/{workspace_id}/domains/{domain_id}/verify", response_model=DomainResponse
)
@limiter.limit("20/minute")
async def verify_domain(
    request: Request,
    workspace_id: str,
    domain_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    domain = await domain_service.verify_domain(db, workspace_id, domain_id)
    return _to_response(domain)


@router.post(
    "/workspaces/{workspace_id}/domains/{domain_id}/attach", response_model=DomainResponse
)
@limiter.limit("20/minute")
async def attach_domain(
    request: Request,
    workspace_id: str,
    domain_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Attach a verified host so the edge will terminate TLS for it.

    Returns 501 rather than a 500 when no hosting credentials are configured:
    that is a deployment that hasn't enabled the integration, not a fault, and
    the caller should be told to finish the step by hand.
    """
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    try:
        domain = await domain_service.attach_to_hosting(db, workspace_id, domain_id)
    except domain_service.AttachUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    return _to_response(domain)


@router.get(
    "/workspaces/{workspace_id}/domains/{domain_id}/provider",
    response_model=DnsProviderHint,
)
@limiter.limit("30/minute")
async def dns_provider_hint(
    request: Request,
    workspace_id: str,
    domain_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Which DNS panel this customer is about to open.

    A separate endpoint rather than a field on the domain list, because it costs
    a live DNS lookup and the list is rendered on every visit to the tab. The UI
    asks for it only while the setup instructions are actually on screen.
    """
    await ws_service.require_role(db, workspace_id, user.id, "viewer")
    domains = await domain_service.list_domains(db, workspace_id)
    domain = next((d for d in domains if d.id == domain_id), None)
    if domain is None:
        raise HTTPException(status_code=404, detail="Domain not found")

    provider, nameservers = await run_in_threadpool(dns_provider_service.detect, domain.host)
    response = _to_response(domain)
    if provider is None:
        return DnsProviderHint(detected=False, nameservers=nameservers[:4])

    zone = dns_provider_service.zone_of(domain.host)

    def relative(name: str) -> str:
        name = name.rstrip(".")
        if not provider.wants_relative:
            return name
        if name == zone:
            return "@"
        return name[: -(len(zone) + 1)] if name.endswith("." + zone) else name

    return DnsProviderHint(
        detected=True,
        provider_id=provider.id,
        provider_name=provider.name,
        panel_url=provider.url.replace("{domain}", zone),
        host_field=provider.host_field,
        record_host=relative(response.dns_record_name),
        target_host=relative(response.dns_target_name),
        note=provider.note or None,
        nameservers=nameservers[:4],
    )


@router.delete("/workspaces/{workspace_id}/domains/{domain_id}", status_code=204)
@limiter.limit("20/minute")
async def remove_domain(
    request: Request,
    workspace_id: str,
    domain_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    await ws_service.require_role(db, workspace_id, user.id, "admin")
    await domain_service.remove_domain(db, workspace_id, domain_id)


@router.get("/host", response_model=HostResolution | None)
@limiter.limit("600/minute")
async def resolve_host(
    request: Request,
    response: Response,
    host: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Which workspace owns this host, plus everything needed to render it.

    Public and unauthenticated by necessity — the edge asks this before it knows
    who the visitor is, and every field it returns is already visible to anyone
    who loads the page. Cached hard, because it sits in front of every request on
    a custom domain and the answer changes about once a year.
    """
    resolved = await domain_service.resolve_host(db, host)
    if resolved is None:
        response.headers["Cache-Control"] = "public, max-age=60"
        return None

    workspace = await ws_service.get_workspace(db, resolved.workspace_id)
    if workspace is None:
        # A domain whose workspace is gone must not resolve to anything.
        response.headers["Cache-Control"] = "public, max-age=60"
        return None

    b, s = workspace.branding, workspace.settings
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=86400"
    return HostResolution(
        host=resolved.host,
        workspace_id=resolved.workspace_id,
        kind=resolved.kind,
        site_name=b.site_name,
        favicon_url=b.favicon_url,
        logo_url=b.logo_url,
        accent_color=b.accent_color,
        hide_markdrop_branding=b.hide_markdrop_branding,
        viewer_chrome=s.viewer_chrome,
        require_auth_to_view=s.require_auth_to_view,
    )
