-- CreateTable
CREATE TABLE "BootstrapToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "machineId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BootstrapToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BootstrapToken_tokenHash_key" ON "BootstrapToken"("tokenHash");

-- CreateIndex
CREATE INDEX "BootstrapToken_accountId_idx" ON "BootstrapToken"("accountId");

-- AddForeignKey
ALTER TABLE "BootstrapToken" ADD CONSTRAINT "BootstrapToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
