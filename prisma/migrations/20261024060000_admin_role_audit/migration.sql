CREATE TABLE "AdminRoleAudit" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "actorId" INTEGER,
 "actorEmail" TEXT,
 "targetId" INTEGER NOT NULL,
 "targetEmail" TEXT NOT NULL,
 "action" TEXT NOT NULL,
 "fromRole" "UserRole" NOT NULL,
 "toRole" "UserRole" NOT NULL,
 "reason" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AdminRoleAudit_targetId_id_idx" ON "AdminRoleAudit"("targetId", "id");
