/**
 * Team icons (the New team dialog's "Icons" tab, Lucide): stored on the team as `glyph:<name>`. Kept out of
 * ./lucide so pages without teams don't carry them.
 */
import {
  BookOpen, Box, Briefcase, Building2, Camera, ChartLine, Code2, Coffee, Cpu, Database, DollarSign, FlaskConical, Gift, Globe,
  GraduationCap, Handshake, Headphones, Heart, Leaf, Megaphone, Mic, Palette, Palmtree, PenTool, Plane, Rocket, Scale, Shield,
  ShoppingCart, Star, Target, Trophy, Truck, Users, Wrench, Zap, type LucideIcon,
} from "lucide-react";

export const TEAM_GLYPHS: Record<string, LucideIcon> = {

  building: Building2, rocket: Rocket, code: Code2, megaphone: Megaphone, handshake: Handshake, chart: ChartLine,
  briefcase: Briefcase, users: Users, heart: Heart, star: Star, target: Target, wrench: Wrench, palette: Palette,
  scale: Scale, book: BookOpen, cpu: Cpu, truck: Truck, cart: ShoppingCart, headphones: Headphones, pen: PenTool,
  school: GraduationCap, lab: FlaskConical, money: DollarSign, camera: Camera, coffee: Coffee, gift: Gift,
  trophy: Trophy, plane: Plane, leaf: Leaf, box: Box, database: Database, shield: Shield, globe: Globe, zap: Zap,
  mic: Mic, palm: Palmtree,
};
