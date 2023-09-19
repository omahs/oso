/*
  Warnings:

  - Added the required column `version` to the `RangedEventPointer` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RangedEventPointer" ADD COLUMN     "version" INTEGER NOT NULL;
