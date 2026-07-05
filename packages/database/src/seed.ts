/**
 * Deterministic development seed. Creates ONLY tenancy/brand/vertical/project
 * scaffolding with fixed UUIDs — no fabricated research findings, trends or
 * analytics, so the UI's empty states remain honest.
 *
 * Run with: pnpm db:seed (idempotent — safe to re-run).
 */
import { PrismaClient } from '@prisma/client';

export const SEED_IDS = {
  user: '00000000-0000-4000-8000-000000000001',
  organization: '00000000-0000-4000-8000-000000000010',
  membership: '00000000-0000-4000-8000-000000000011',
  workspace: '00000000-0000-4000-8000-000000000020',
  brand: '00000000-0000-4000-8000-000000000030',
  vertical: '00000000-0000-4000-8000-000000000040',
  researchProject: '00000000-0000-4000-8000-000000000050',
} as const;

export async function seed(prisma: PrismaClient): Promise<void> {
  const user = await prisma.user.upsert({
    where: { id: SEED_IDS.user },
    update: {},
    create: {
      id: SEED_IDS.user,
      email: 'demo@spectra.local',
      name: 'Demo User',
      timezone: 'Asia/Kolkata',
      locale: 'en',
      status: 'ACTIVE',
    },
  });

  const organization = await prisma.organization.upsert({
    where: { id: SEED_IDS.organization },
    update: {},
    create: {
      id: SEED_IDS.organization,
      slug: 'spectra-demo',
      name: 'Spectra Demo Organization',
      status: 'ACTIVE',
    },
  });

  await prisma.membership.upsert({
    where: { id: SEED_IDS.membership },
    update: {},
    create: {
      id: SEED_IDS.membership,
      organizationId: organization.id,
      userId: user.id,
      role: 'ORG_OWNER',
      status: 'ACTIVE',
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { id: SEED_IDS.workspace },
    update: {},
    create: {
      id: SEED_IDS.workspace,
      organizationId: organization.id,
      slug: 'growth',
      name: 'Growth Workspace',
      description: 'Default workspace created by the development seed.',
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
    },
  });

  await prisma.brand.upsert({
    where: { id: SEED_IDS.brand },
    update: {},
    create: {
      id: SEED_IDS.brand,
      organizationId: organization.id,
      workspaceId: workspace.id,
      slug: 'spectra-demo-brand',
      name: 'Spectra Demo Brand',
      description: 'Example brand profile for local development.',
      voice: {
        tone: ['confident', 'practical'],
        personality: 'A pragmatic engineering-led brand voice.',
        doNots: ['unverifiable claims', 'hype without evidence'],
        examplePhrases: [],
      },
      languages: ['en'],
      status: 'ACTIVE',
    },
  });

  await prisma.customVertical.upsert({
    where: { id: SEED_IDS.vertical },
    update: {},
    create: {
      id: SEED_IDS.vertical,
      organizationId: organization.id,
      workspaceId: workspace.id,
      slug: 'ai-powered-software-testing',
      name: 'AI-powered software testing',
      description:
        'Example user-defined vertical: AI-assisted quality engineering tools and practices.',
      industry: 'Software quality engineering',
      subIndustry: 'AI-assisted testing',
      businessModel: 'B2B SaaS',
      targetAudiences: [
        { name: 'QA managers', roles: ['QA Manager', 'Head of Quality'], description: null },
        { name: 'Technology leaders', roles: ['CTO', 'VP Engineering'], description: null },
      ],
      customerPainPoints: ['flaky test suites', 'slow release cycles', 'limited QA bandwidth'],
      geographies: ['India', 'Global'],
      languages: ['en'],
      keywords: ['AI testing', 'test automation', 'quality engineering', 'LLM test generation'],
      excludedKeywords: ['gaming QA'],
      trustedDomains: [],
      blockedDomains: [],
      commercialObjectives: ['generate qualified B2B leads'],
      contentObjectives: ['establish thought leadership'],
      preferredPlatforms: ['LINKEDIN', 'YOUTUBE'],
      relevanceCriteria: [
        { criterion: 'Relevant to enterprise QA teams', weight: 1 },
        { criterion: 'Actionable for Indian technology market', weight: 0.8 },
      ],
      status: 'ACTIVE',
    },
  });

  await prisma.researchProject.upsert({
    where: { id: SEED_IDS.researchProject },
    update: {},
    create: {
      id: SEED_IDS.researchProject,
      organizationId: organization.id,
      workspaceId: workspace.id,
      verticalId: SEED_IDS.vertical,
      brandId: SEED_IDS.brand,
      createdById: user.id,
      name: 'AI in quality engineering — landscape scan',
      objective:
        'Research the latest developments in AI-powered quality engineering in India and globally.',
      status: 'DRAFT',
    },
  });

  await prisma.auditLog.create({
    data: {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorType: 'SYSTEM',
      action: 'seed.applied',
      resourceType: 'Database',
      metadata: { seedVersion: 1 },
    },
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
    console.log('Seed completed: demo user, organization, workspace, brand, vertical, project.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
