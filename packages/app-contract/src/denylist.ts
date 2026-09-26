/** Packages that can't run on the platform, with the alternative to use (CON-3.2). */
export const DENYLIST: { packages: string[]; reason: string; alternative: string }[] = [
  { packages: ['express', 'koa', 'fastify', '@nestjs/*'], reason: 'Node HTTP servers', alternative: '`hono`' },
  {
    packages: ['next', '@remix-run/*', 'nuxt', '@sveltejs/kit'],
    reason: 'Other frameworks (not in this contract)',
    alternative: 'Vite + React + Hono',
  },
  {
    packages: ['prisma', '@prisma/client', 'typeorm', 'sequelize', 'mongoose'],
    reason: 'Unsupported ORMs / databases',
    alternative: '`drizzle-orm` with D1',
  },
  {
    packages: ['sqlite3', 'better-sqlite3', 'pg', 'mysql2'],
    reason: 'Native / TCP database drivers',
    alternative: '`env.DB` (D1)',
  },
  {
    packages: ['bcrypt', 'argon2', 'sharp', 'canvas', 'puppeteer'],
    reason: 'Native addons',
    alternative: 'WebCrypto (PBKDF2) or `bcryptjs`',
  },
  { packages: ['nodemailer'], reason: 'SMTP', alternative: '`env.EMAIL.send()`' },
  { packages: ['dotenv'], reason: 'Env files', alternative: '`set_secret` + `env`' },
];
