import { RadarSpinner } from "@/components/ui/radar-spinner";

/** A page inside the shell is loading: the sidebar and topbar stay put, the main pane waits. */
export default function TeamPageLoading() {
  return (
    <div role="status" aria-label="Loading" className="grid h-full min-h-60 place-items-center text-faint">
      <RadarSpinner className="size-5" />
    </div>
  );
}
