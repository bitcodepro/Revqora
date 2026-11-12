import { Copy, Link2 } from "lucide-react";
import { api } from "../lib/api";
import { basename } from "../lib/format";
import { safeWebUrl } from "../lib/prCenter";
import { copyText, toast, type MenuItem } from "../lib/ui";

export function copyUrlMenu(resolve: () => string | null | Promise<string | null>, unavailable: string): MenuItem {
  return {
    label: "Copy URL",
    icon: <Link2 size={14} />,
    onClick: async () => {
      try {
        const url = safeWebUrl(await resolve());
        if (url) await copyText(url, "URL copied");
        else toast.info("No shareable URL", unavailable);
      } catch (error) {
        toast.error(error, "Could not copy URL");
      }
    },
  };
}

function copyNameItem(name: string, shortcut?: string): MenuItem {
  return { label: "Copy name", shortcut, icon: <Copy size={14} />, onClick: () => { void copyText(name, "Name copied"); } };
}

export function copyFileNameItem(path: string, shortcut?: string): MenuItem {
  return copyNameItem(basename(path), shortcut);
}

export function fileCopyMenu(path: string): MenuItem[] {
  return [
    copyFileNameItem(path),
    { label: "Copy path", icon: <Copy size={14} />, onClick: () => { void copyText(path, "Path copied"); } },
  ];
}

/** A branch has no separate filesystem folder; its path is the repository root. */
export function namePathMenu(name: string, root: string, reference?: string | null): MenuItem[] {
  const items: MenuItem[] = [
    copyNameItem(name),
    { label: "Copy path", icon: <Copy size={14} />, onClick: () => { void copyText(root, "Repository path copied"); } },
  ];
  if (reference !== undefined) {
    items.push(copyUrlMenu(() => api.repositoryWebLink(root, reference), reference
      ? "This branch needs a known remote branch on a supported Git host."
      : "This repository needs a remote with a web address."));
  }
  return items;
}
