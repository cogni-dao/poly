"use client";

import {
	SidebarMenuButton as BaseSidebarMenuButton,
	SidebarMenuSubButton as BaseSidebarMenuSubButton,
} from "@cogni/node-ui-kit/shadcn/sidebar";
import type { ComponentProps } from "react";
import { cn } from "@/shared/util/cn";

export function SidebarMenuButton({
	className,
	...props
}: ComponentProps<typeof BaseSidebarMenuButton>) {
	return (
		<BaseSidebarMenuButton
			className={cn("data-[active=true]:bg-sidebar-accent", className)}
			{...props}
		/>
	);
}

export function SidebarMenuSubButton({
	className,
	...props
}: ComponentProps<typeof BaseSidebarMenuSubButton>) {
	return (
		<BaseSidebarMenuSubButton
			className={cn("data-[active=true]:bg-sidebar-accent", className)}
			{...props}
		/>
	);
}
