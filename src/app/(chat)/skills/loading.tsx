import { Skeleton } from "ui/skeleton";

export default function SkillsLoading() {
  return (
    <div className="w-full p-5 sm:p-8">
      <div className="mb-8 flex justify-between">
        <div className="grid gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="mb-10 grid gap-4">
          <Skeleton className="h-6 w-32" />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} className="h-[196px]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
