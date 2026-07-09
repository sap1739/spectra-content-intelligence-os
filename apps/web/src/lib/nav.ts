import {
  BadgeIndianRupee,
  BarChart3,
  Boxes,
  Calendar,
  FileText,
  FlaskConical,
  Home,
  Image,
  Layers,
  LayoutTemplate,
  Megaphone,
  Search,
  Settings,
  Share2,
  Sparkles,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Which delivery phase makes this area functional. */
  phase: 1 | 2 | 3 | 4;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Home', href: '/', icon: Home, phase: 1 },
      { label: 'Intelligence', href: '/intelligence', icon: Sparkles, phase: 2 },
    ],
  },
  {
    label: 'Research',
    items: [
      { label: 'Research', href: '/research', icon: FlaskConical, phase: 2 },
      { label: 'Trends', href: '/trends', icon: TrendingUp, phase: 2 },
    ],
  },
  {
    label: 'Creation',
    items: [
      { label: 'Strategy', href: '/create', icon: Search, phase: 3 },
      { label: 'Campaigns', href: '/campaigns', icon: Megaphone, phase: 3 },
      { label: 'Content', href: '/content', icon: FileText, phase: 3 },
      { label: 'Calendar', href: '/calendar', icon: Calendar, phase: 3 },
      { label: 'Media', href: '/media', icon: Image, phase: 3 },
      { label: 'Templates', href: '/templates', icon: LayoutTemplate, phase: 3 },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { label: 'Brands', href: '/brands', icon: Layers, phase: 2 },
      { label: 'Verticals', href: '/verticals', icon: Boxes, phase: 2 },
      { label: 'Social Accounts', href: '/social-accounts', icon: Share2, phase: 4 },
    ],
  },
  {
    label: 'Insights',
    items: [{ label: 'Analytics', href: '/analytics', icon: BarChart3, phase: 4 }],
  },
  {
    label: 'Organization',
    items: [
      { label: 'Team', href: '/team', icon: Users, phase: 2 },
      { label: 'Billing', href: '/billing', icon: BadgeIndianRupee, phase: 4 },
      { label: 'Settings', href: '/settings', icon: Settings, phase: 2 },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
