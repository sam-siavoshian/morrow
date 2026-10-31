import { SearchX } from "lucide-react";
import { BackHomeLink } from "@/components/shell/back-home-link";
import { EmptyState } from "@/components/ui/empty-state";

/** A task or page in this team that does not exist (or you cannot see). Shown inside the shell. */
export default function TeamNotFound() {
  return (
    <div className="grid h-full min-h-80 place-items-center px-4">
      <EmptyState
        icon={<SearchX />}
        title="Nothing here"
        description="This task or page doesn't exist, or you don't have access to it."
        action={<BackHomeLink />}
      />
    </div>
  );
}
