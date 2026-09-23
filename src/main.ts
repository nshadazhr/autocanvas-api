import "dotenv/config"; // plain Node process, like apps/worker — doesn't auto-load .env the way Next.js does
import "reflect-metadata"; // required once, globally, for Nest's decorator-based DI to work
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { registerBuiltInAudioProviders } from "@platform/ai-core";
import { AppModule } from "./app.module";

// AudioProvider implementations (mock, elevenlabs, ...) register themselves
// into ai-core's in-memory registry exactly once per process — same call
// apps/worker's src/index.ts makes at startup, needed here too now that
// this process (not apps/web) is the one estimating generation cost.
registerBuiltInAudioProviders();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Every DTO in src/**/dto is a class-validator class — this pipe is what
  // actually runs those decorators against incoming request bodies and
  // rejects anything invalid with a 400, before a controller method ever
  // sees it.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Only relevant once a browser ever calls this API directly — today
  // every caller is apps/web's own server (a server-to-server fetch, which
  // isn't subject to CORS at all), but this is here so that isn't a
  // surprise blocker later.
  app.enableCors({ origin: process.env.FRONTEND_URL ?? "http://localhost:3000" });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`[backend] listening on http://localhost:${port}`);
  console.log("[backend] modules: audio (pilot) — billing/dashboard/credits still served by apps/web directly");
}

bootstrap();
