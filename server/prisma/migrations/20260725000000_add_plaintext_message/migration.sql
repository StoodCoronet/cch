-- CreateTable
CREATE TABLE "PlaintextMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaintextMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaintextMessage_sessionId_createdAt_idx" ON "PlaintextMessage"("sessionId", "createdAt");
