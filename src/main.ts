import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { useSafeBodyParsers } from './common/body-parser.js';
import { loadDotEnv, parseEnv } from './config/env.js';

loadDotEnv();
const env = parseEnv(); // fail fast before Nest starts wiring anything

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false, // registered by useSafeBodyParsers, with sanitized errors
});
useSafeBodyParsers(app);
app.enableShutdownHooks();
await app.listen(env.PORT);
