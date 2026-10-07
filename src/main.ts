import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadDotEnv, parseEnv } from './config/env.js';

loadDotEnv();
const env = parseEnv(); // fail fast before Nest starts wiring anything

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(env.PORT);
