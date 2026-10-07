-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'NEEDS_HUMAN_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewReason" AS ENUM ('LOW_CONFIDENCE', 'INVALID_OUTPUT', 'UNGROUNDED_EVIDENCE', 'SUSPECTED_INJECTION', 'MODEL_REFUSED', 'PROVIDER_FAILURE');

-- CreateEnum
CREATE TYPE "LlmCallKind" AS ENUM ('INITIAL', 'REPAIR');

-- CreateEnum
CREATE TYPE "LlmCallOutcome" AS ENUM ('OK', 'SCHEMA_INVALID', 'UNGROUNDED', 'TRUNCATED', 'REFUSED', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'NON_RETRYABLE_ERROR');

-- CreateTable
CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "status" "InquiryStatus" NOT NULL DEFAULT 'RECEIVED',
    "reviewReason" "ReviewReason",
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "jobAttempt" INTEGER NOT NULL,
    "kind" "LlmCallKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "outcome" "LlmCallOutcome" NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_idempotencyKey_key" ON "inquiries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "inquiries_status_createdAt_idx" ON "inquiries"("status", "createdAt");

-- CreateIndex
CREATE INDEX "llm_calls_inquiryId_createdAt_idx" ON "llm_calls"("inquiryId", "createdAt");

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
