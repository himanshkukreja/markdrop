/**
 * Markdrop icon set: one stroked path per glyph on a 24px grid, drawn at 1.8 stroke with round caps
 * and joins by `.md-icon` (markdrop.css). Circles and rects are written as arcs so every icon is a
 * single `d` string. Geometry follows Lucide (ISC) where a Lucide glyph exists.
 *
 * Meanings that must stay distinct (REVAMP_PLAN 6.3): `lock` = access and passwords, `key` = E2E
 * keys and secrets, `shield` = the isolated artifact domain; `share` (nodes) is never `upload`.
 *
 * No "use client": this module is plain data, so server components may import it directly.
 */
declare const PATHS: {
    check: string;
    x: string;
    plus: string;
    minus: string;
    chevronDown: string;
    chevronUp: string;
    chevronRight: string;
    chevronLeft: string;
    more: string;
    search: string;
    link: string;
    copy: string;
    doc: string;
    lines: string;
    builder: string;
    upload: string;
    download: string;
    image: string;
    lock: string;
    eye: string;
    eyeOff: string;
    user: string;
    userX: string;
    globe: string;
    info: string;
    alert: string;
    alertCircle: string;
    checkCircle: string;
    bulb: string;
    arrowRight: string;
    wave: string;
    edit: string;
    trash: string;
    folder: string;
    external: string;
    code: string;
    bold: string;
    italic: string;
    heading: string;
    list: string;
    home: string;
    settings: string;
    expand: string;
    zap: string;
    clock: string;
    film: string;
    archive: string;
    table: string;
    checkSquare: string;
    sun: string;
    moon: string;
    inbox: string;
    github: string;
    menu: string;
    pause: string;
    play: string;
    stop: string;
    server: string;
    laptop: string;
    phone: string;
    tablet: string;
    monitor: string;
    terminal: string;
    refresh: string;
    rotate: string;
    history: string;
    key: string;
    shield: string;
    grip: string;
    calendar: string;
    qr: string;
    printer: string;
    columns: string;
    clipboard: string;
    flag: string;
    userPlus: string;
    users: string;
    mail: string;
    send: string;
    share: string;
    logOut: string;
    arrowLeft: string;
    arrowUp: string;
    arrowDown: string;
    arrowUpRight: string;
    message: string;
    bug: string;
    chart: string;
    filter: string;
    sort: string;
    hash: string;
    listTree: string;
    wrap: string;
    minimize: string;
    zoomIn: string;
    zoomOut: string;
    wifiOff: string;
    music: string;
    sigma: string;
    palette: string;
    google: string;
    sparkle: string;
    layers: string;
    droplet: string;
};
/** Every icon name in the set. `Icon` still accepts any string (unknown names draw nothing). */
export type IconName = keyof typeof PATHS;
/** Typed so both `ICONS.check` and `ICONS[someString]` work (the pre-vendoring type was Record<string, string>). */
export declare const ICONS: Record<IconName, string> & Record<string, string>;
export {};
