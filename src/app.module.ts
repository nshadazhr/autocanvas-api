import { Module } from "@nestjs/common";
import { AudioModule } from "./audio/audio.module";

// Billing/Dashboard/Credits are explicitly OUT of scope for this pilot —
// they stay as apps/web Server Actions calling packages directly, same as
// apps/admin stays on direct DB access. Audio Studio is the only module
// that talks to this backend today. Extending this app to a second module
// later is: add `modules/<name>/<name>.module.ts`, import it here.
@Module({
  imports: [AudioModule],
})
export class AppModule {}
