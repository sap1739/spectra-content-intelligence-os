'use client';

import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@spectra/ui';
import { FileCode, Info } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { useCapabilities } from '@/lib/knowledge';

/**
 * Templates.
 *
 * There is no user-editable template store, so this page does NOT present an
 * empty list implying one is coming. It reports the one thing that genuinely
 * exists — the versioned prompt template every generated draft is attributed
 * to — and states plainly what is absent.
 */
export default function TemplatesPage() {
  const capabilities = useCapabilities();
  const templates = capabilities.data?.templates;

  return (
    <>
      <PageHeader
        title="Templates"
        description="What actually shapes generated content today: one versioned prompt template, recorded on every draft for attribution."
      />

      <Card className="mb-6">
        <CardContent className="flex items-start gap-3 py-4">
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">No user-defined templates exist yet</p>
            <p className="text-muted-foreground">
              You cannot create, edit or save templates here, and none are stored per workspace.
              Generation uses a single built-in prompt template, versioned so drafts stay
              attributable and regressions are bisectable. Visual and video templates are not
              implemented. Brand voice — the thing that actually varies content per brand today — is
              configured on <span className="font-medium">Brands</span>.
            </p>
          </div>
        </CardContent>
      </Card>

      {capabilities.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : capabilities.isError ? (
        <EmptyState
          icon={<FileCode />}
          title="Could not load template information"
          description={capabilities.error.message}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Built-in prompt template</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3">
                {(templates?.builtIn ?? []).map((template) => (
                  <li key={template.id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{template.displayName}</span>
                      <span className="flex gap-1">
                        <Badge variant="secondary">{template.kind.toLowerCase()}</Badge>
                        <Badge variant="muted">v{template.version}</Badge>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{template.id}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">{templates?.note}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Formats it produces</CardTitle>
              <p className="text-xs text-muted-foreground">
                The shape the template asks for, per content type. These are prompt instructions,
                not layout templates.
              </p>
            </CardHeader>
            <CardContent>
              <dl className="flex flex-col gap-2 text-xs">
                {Object.entries(templates?.contentTypeFormats ?? {}).map(([type, format]) => (
                  <div key={type} className="flex gap-2">
                    <dt className="w-28 shrink-0 font-medium">{type}</dt>
                    <dd className="text-muted-foreground">{format}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
