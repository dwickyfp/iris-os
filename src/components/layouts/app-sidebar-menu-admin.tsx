import { Activity, Settings, Shield, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import {
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "ui/sidebar";
import { SidebarMenuItem } from "ui/sidebar";
import { SidebarMenuButton } from "ui/sidebar";
import { Tooltip } from "ui/tooltip";

const AppSidebarAdmin = () => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("Admin");
  const shouldExpandAdmin = useMemo(() => {
    return pathname.startsWith("/admin");
  }, [pathname]);
  const adminNavItems = useMemo(
    () => [
      {
        id: "users",
        title: t("Users.title"),
        url: "/admin",
        icon: Users,
        isActive: pathname.startsWith("/admin/users"),
      },
      {
        id: "operations",
        title: "Operations",
        url: "/admin/operations",
        icon: Activity,
        isActive: pathname.startsWith("/admin/operations"),
      },
      {
        id: "settings",
        title: "System settings",
        url: "/admin/settings",
        icon: Settings,
        isActive: pathname.startsWith("/admin/settings"),
      },
    ],
    [t, pathname],
  );

  return (
    <SidebarMenu className="group/admin">
      <Tooltip>
        <SidebarMenuItem>
          <Link href="/admin" data-testid="admin-sidebar-link">
            <SidebarMenuButton className="font-semibold">
              <Shield className="size-4 text-foreground" />
              {t("title")}
            </SidebarMenuButton>
          </Link>
        </SidebarMenuItem>
      </Tooltip>
      {shouldExpandAdmin && (
        <SidebarMenuSub className="mb-2">
          {adminNavItems.map((item) => (
            <SidebarMenuSubItem key={item.id}>
              <SidebarMenuSubButton
                className="text-muted-foreground"
                data-testid={`admin-sidebar-link-${item.id}`}
                onClick={() => {
                  router.push(item.url);
                }}
                isActive={item.isActive}
              >
                <item.icon className="size-4" />
                {item.title}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenu>
  );
};

export { AppSidebarAdmin };
