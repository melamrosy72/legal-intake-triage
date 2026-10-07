import { Global, Module } from '@nestjs/common';
import { ENV, parseEnv } from './env.js';

/** Makes the validated environment injectable everywhere as `@Inject(ENV)`. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => parseEnv() }],
  exports: [ENV],
})
export class EnvModule {}
