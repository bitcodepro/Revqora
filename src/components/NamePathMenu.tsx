import { Copy } from "lucide-react";
import { copyText, type MenuItem } from "../lib/ui";

/** A branch has no separate filesystem folder; its path is the repository root. */
export function namePathMenu(name: string, root: string): MenuItem[] {
  return [
    { label: "Copy name", icon: <Copy size={14} />, onClick: () => { void copyText(name, "Name copied"); } },
    { label: "Copy path", icon: <Copy size={14} />, onClick: () => { void copyText(root, "Repository path copied"); } },
  ];
}
