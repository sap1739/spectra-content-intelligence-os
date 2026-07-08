'use client';

import { Badge, Card, CardContent, EmptyState, Input, Skeleton } from '@spectra/ui';
import { ExternalLink, Search, Sparkles } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useKnowledgeSearch } from '@/lib/knowledge';

function ScorePill({ score }: { score: number }) {
  return <Badge variant="outline">match {(score * 100).toFixed(0)}%</Badge>;
}

function IntelligenceSearch() {
  const { activeWorkspace } = useWorkspace();
  const params = useSearchParams();
  const [input, setInput] = React.useState(params.get('q') ?? '');
  const [query, setQuery] = React.useState(params.get('q') ?? '');
  const results = useKnowledgeSearch(activeWorkspace.id, query);

  return (
    <>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
        className="relative mb-6 max-w-2xl"
      >
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search your research knowledge base…"
          aria-label="Search knowledge base"
          className="h-11 pl-9 text-base"
        />
      </form>

      {query.trim().length < 2 ? (
        <EmptyState
          icon={<Sparkles />}
          title="Search everything your research has learned"
          description="Every finding your runs ingest is embedded into the knowledge base. Search is lexical in Phase 2 (exact and near-word matches, ADR-0016); semantic models arrive in Phase 3."
        />
      ) : results.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full max-w-3xl" />
          <Skeleton className="h-20 w-full max-w-3xl" />
        </div>
      ) : results.isError ? (
        <EmptyState icon={<Sparkles />} title="Search failed" description={results.error.message} />
      ) : results.data.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title={`No matches for “${query}”`}
          description="Only ingested findings are searchable — run research over more feeds to grow the knowledge base."
        />
      ) : (
        <ul className="flex max-w-3xl flex-col gap-3">
          {results.data.map((hit) => (
            <li key={hit.chunkId}>
              <Card>
                <CardContent className="flex flex-col gap-2 pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug">
                      {hit.metadata.title ?? hit.text.slice(0, 80)}
                    </p>
                    <ScorePill score={hit.score} />
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{hit.text}</p>
                  {hit.metadata.sourceUrl ? (
                    <a
                      href={hit.metadata.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      Open source <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function IntelligencePage() {
  return (
    <>
      <PageHeader
        title="Intelligence"
        description="Search across everything your research runs have ingested — findings, provenance and topics."
      />
      <React.Suspense fallback={<Skeleton className="h-11 w-full max-w-2xl" />}>
        <IntelligenceSearch />
      </React.Suspense>
    </>
  );
}
