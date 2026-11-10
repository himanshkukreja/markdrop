/**
 * The app's icons are Lucide (lucide-react, ISC). Every `Icon name` (./icons' names, which already followed
 * Lucide's geometry) maps to its closest Lucide component here; named imports keep the bundle to these few
 * dozen glyphs. Brand marks (Google, GitHub) and product art stay hand-drawn in ./icons.
 *
 * Meanings that must stay distinct (REVAMP_PLAN 6.3): `lock` = access and passwords, `key` = E2E keys and
 * secrets, `shield` = the isolated artifact domain, `shieldCheck` = the admin console; `share` is never `upload`.
 */
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Bell, Bold, Bug, Building2, Calendar,
  ChartColumn, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleHelp, Info,
  Clipboard, Clock, Code, Columns2, Compass, Copy, Download, Droplet, Ellipsis, ExternalLink, Eye, EyeOff, FileText,
  Film, Filter, Flag, Folder, Globe, Grid2x2, GripVertical, Hash, Heading, History, House, Image, Inbox, Italic, Key,
  Laptop, Layers, LayoutGrid, LayoutPanelLeft, Lightbulb, Link, List, ListTree, Lock, LogOut, Mail, Maximize2,
  Megaphone, Menu, MessageSquare, MessageSquarePlus, Mic, Minimize2, Minus, Monitor, Moon, Music, Palette, Pause,
  Pencil, Pipette, Play, Plus, Presentation, Printer, QrCode, Redo2, RefreshCw, RotateCw, Search, Send, Server,
  Settings, Share2, Shield, ShieldCheck, Sigma, Smartphone, Smile, Sparkles, Square, SquareCheckBig, SquareStop, Sun,
  Table, Tablet, Trash2, Terminal, TextAlignStart, TriangleAlert, Type, Undo2, Upload, User, UserPlus, UserX, Users,
  Activity, WifiOff, WrapText, X, Zap, ZoomIn, ZoomOut, ArrowUpDown, Rocket, Briefcase, Heart, Star, Target,
  Wrench, Palmtree, Handshake, ChartLine, Scale, BookOpen, Cpu, Truck, ShoppingCart, Headphones, PenTool,
  GraduationCap, FlaskConical, DollarSign, Code2, Camera, Coffee, Gift, Trophy, Plane, Leaf, Box, Database,
  type LucideIcon,
} from "lucide-react";

export const LUCIDE: Record<string, LucideIcon> = {
  check: Check, x: X, plus: Plus, minus: Minus,
  chevronDown: ChevronDown, chevronUp: ChevronUp, chevronRight: ChevronRight, chevronLeft: ChevronLeft,
  more: Ellipsis, search: Search, link: Link, copy: Copy, doc: FileText, lines: TextAlignStart, builder: List,
  upload: Upload, download: Download, image: Image, lock: Lock, eye: Eye, eyeOff: EyeOff, user: User, userX: UserX,
  globe: Globe, info: Info, alert: TriangleAlert, alertCircle: CircleAlert, checkCircle: CircleCheck, bulb: Lightbulb,
  arrowRight: ArrowRight, wave: Activity, edit: Pencil, trash: Trash2, folder: Folder, external: ExternalLink,
  code: Code, bold: Bold, italic: Italic, heading: Heading, list: List, grid: LayoutGrid, cards: Columns2, home: House,
  settings: Settings, expand: Maximize2, zap: Zap, clock: Clock, film: Film, archive: Archive, table: Table,
  checkSquare: SquareCheckBig, sun: Sun, moon: Moon, bell: Bell, inbox: Inbox, menu: Menu, pause: Pause, play: Play,
  stop: SquareStop, server: Server, laptop: Laptop, phone: Smartphone, tablet: Tablet, slides: Presentation,
  monitor: Monitor, terminal: Terminal, refresh: RefreshCw, rotate: RotateCw, history: History, key: Key,
  shield: Shield, shieldCheck: ShieldCheck, grip: GripVertical, calendar: Calendar, qr: QrCode, printer: Printer,
  columns: Columns2, sidebar: LayoutPanelLeft, clipboard: Clipboard, flag: Flag, megaphone: Megaphone,
  userPlus: UserPlus, users: Users, mail: Mail, send: Send, share: Share2, logOut: LogOut, arrowLeft: ArrowLeft,
  arrowUp: ArrowUp, arrowDown: ArrowDown, arrowUpRight: ArrowUpRight, message: MessageSquare, mic: Mic, bug: Bug,
  chart: ChartColumn, filter: Filter, sort: ArrowUpDown, hash: Hash, listTree: ListTree, wrap: WrapText,
  minimize: Minimize2, zoomIn: ZoomIn, zoomOut: ZoomOut, wifiOff: WifiOff, music: Music, sigma: Sigma,
  palette: Palette, sparkle: Sparkles, layers: Layers, droplet: Droplet, undo: Undo2, redo: Redo2, type: Type,
  square: Square, pipette: Pipette, smile: Smile, at: AtSign, messagePlus: MessageSquarePlus,
  // New in the nav redesign (2026-11-10).
  compass: Compass, building: Building2, help: CircleHelp, grid2: Grid2x2, chartLine: ChartLine,
};

/** Team icons (the New team dialog's "Icons" tab): stored on the team as `glyph:<name>`. */
export const TEAM_GLYPHS: Record<string, LucideIcon> = {
  building: Building2, rocket: Rocket, code: Code2, megaphone: Megaphone, handshake: Handshake, chart: ChartLine,
  briefcase: Briefcase, users: Users, heart: Heart, star: Star, target: Target, wrench: Wrench, palette: Palette,
  scale: Scale, book: BookOpen, cpu: Cpu, truck: Truck, cart: ShoppingCart, headphones: Headphones, pen: PenTool,
  school: GraduationCap, lab: FlaskConical, money: DollarSign, camera: Camera, coffee: Coffee, gift: Gift,
  trophy: Trophy, plane: Plane, leaf: Leaf, box: Box, database: Database, shield: Shield, globe: Globe, zap: Zap,
  mic: Mic, palm: Palmtree,
};
