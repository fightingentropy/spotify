"use client";

import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { PageHeader, PageLayout, SectionHeader } from "@/components/PageLayout";
import { useApiData } from "@/client/api";
import { formatEventDate, type LiveEvent, type LiveEventSection } from "@/lib/live-events";

function EventCard({ event, eager }: { event: LiveEvent; eager: boolean }) {
  const { month, day } = formatEventDate(event.date);
  const content = (
    <>
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
        <CoverImage
          src={event.imageUrl}
          alt={event.artists}
          fill
          className="object-cover"
          loading={eager ? "eager" : "lazy"}
          sizes="64px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[15px] font-semibold leading-5" title={event.artists}>
          {event.artists}
        </div>
        <div className="wf-muted mt-1 truncate text-sm" title={event.venue}>{event.venue}</div>
      </div>
      <div className="w-10 shrink-0 text-center">
        <div className="wf-muted text-xs">{month}</div>
        <div className="text-lg font-semibold tabular-nums leading-6">{day}</div>
      </div>
    </>
  );
  const className = "flex min-w-0 items-center gap-4 border-b border-white/[0.08] py-4";
  return event.url ? (
    <a
      className={`${className} rounded-md transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70`}
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View tickets for ${event.artists}`}
    >
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function EventsSkeleton() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-x-8 md:grid-cols-2" aria-hidden>
      {Array.from({ length: 10 }).map((_, item) => (
        <div key={item} className="flex min-w-0 items-center gap-4 border-b border-white/[0.08] py-4">
          <div className="wf-skeleton h-16 w-16 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-2/3 rounded" />
            <div className="wf-skeleton h-3 w-1/2 rounded" />
          </div>
          <div className="wf-skeleton h-10 w-10 rounded-md" />
        </div>
      ))}
    </div>
  );
}

export default function EventsPage() {
  // Public feed (same for everyone) — fetched plain, no account scope. Do not
  // silently substitute old sample dates when the live provider is unavailable.
  const { data, loading, error, retry } = useApiData<{ sections: LiveEventSection[] }>("/api/events", { sections: [] });
  const today = new Date().toISOString().slice(0, 10);
  const sections = data.sections
    .map((section) => ({ ...section, events: section.events.filter((event) => event.date >= today) }))
    .filter((section) => section.events.length > 0);
  const showSkeleton = loading && data.sections.length === 0;

  return (
    <PageLayout>
      <PageHeader title="Live events" description="Concerts and venues in London" />
      {showSkeleton ? (
        <EventsSkeleton />
      ) : error ? (
        <PageError compact message={error} onRetry={retry} retryLabel="Retry" />
      ) : sections.length === 0 ? (
        <div className="wf-empty-state">No upcoming London events are available right now.</div>
      ) : (
        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.key} aria-label={section.title}>
              <SectionHeader title={section.title} description={<span className="whitespace-normal break-words">{section.eyebrow}</span>} />
              <div className="grid min-w-0 grid-cols-1 gap-x-8 md:grid-cols-2">
                {section.events.map((event, index) => (
                  <EventCard key={event.id} event={event} eager={index < 5} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageLayout>
  );
}
