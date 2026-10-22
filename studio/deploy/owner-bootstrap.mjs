// Private transport for `smp prod creator owner-bootstrap` only. Its stdout is
// captured in memory by the fixed root installer, never displayed or logged.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const email = process.env.GOOGLE_AUTH_OWNER_EMAIL?.trim().toLowerCase();
  if (process.env.GOOGLE_ONLY_AUTH !== 'true' || !email || !email.includes('@')) throw new Error();
  const users = await prisma.user.findMany({
    where: { email, providerName: 'GOOGLE', activated: true, deletedAt: null, providerId: { not: null } },
    select: { id: true, email: true, providerId: true, organizations: {
      where: { disabled: false, role: 'SUPERADMIN', organization: { deletedAt: null } },
      select: { organizationId: true, organization: { select: { apiKey: true } } },
    } },
  });
  if (users.length !== 1 || !users[0].providerId || users[0].organizations.length !== 1) throw new Error();
  const user = users[0], membership = user.organizations[0];
  const publicApiKey = membership.organization.apiKey;
  if (!publicApiKey || publicApiKey.length < 32 || publicApiKey.length > 4096) throw new Error();
  process.stdout.write(JSON.stringify({ organizationId: membership.organizationId,
    publicApiKey, userId: user.id, email: user.email }));
} catch {
  process.stderr.write('Owner binding is unavailable. Complete the first verified Google sign-in.\n');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
