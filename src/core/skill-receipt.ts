import { visibleSkill } from "../skill/store";
import { citedStepTotal, citedStepsBySkill } from "./skill-step-citations";

interface SkillReceiptEvidence {
  present: boolean;
  complete: boolean;
  duplicate: boolean;
  receiptCount: number;
  skillApplicationCount: number;
  expectedSteps: number;
  reportedSteps: number;
  updateDispositionPresent: boolean;
  /** The receipt block itself, so a caller can attribute the cited steps to the skills selected. */
  receiptText: string;
}

const count = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

/** Which steps of which selected skill the receipt actually cited. Empty when nothing is attributable. */
export function receiptStepsBySkill(
  receiptText: string, skills: { id: string; title: string }[]
): { id: string; title: string; steps: number[] }[] {
  return citedStepsBySkill(receiptText, skills);
}

// The receipt proves a skill was applied, not that every step was recited. Requiring one cited
// step per selected skill is attainable; requiring the master's full step count never was — across
// 97 checked receipts, zero passed whenever a skill was selected.
export function requiredStepCitations(skillIds: string[]): number {
  return [...new Set(skillIds)].filter((id) => visibleSkill(id)?.masterPrompt).length;
}

export function analyzeSkillReceipt(text: string, expectedSteps: number): SkillReceiptEvidence {
  const receiptHeadings = [
    ...text.matchAll(/(?:^|\n)\s*(?:#{1,3}\s*)?\*{0,2}Cairn\*{0,2}\s*:?\s*(?=\n|$)/gim),
  ];
  const receiptCount = receiptHeadings.length;
  const firstHeading = receiptHeadings[0];
  const receiptStart = firstHeading?.index ?? -1;
  const afterHeading = receiptStart >= 0
    ? receiptStart + firstHeading![0].length
    : -1;
  const followingText = afterHeading >= 0 ? text.slice(afterHeading) : "";
  const nextMarkdownSection = followingText.search(/\n\s*#{1,6}\s+\S/);
  const nextReceipt = receiptHeadings[1]?.index ?? -1;
  const receiptEndCandidates = [
    nextMarkdownSection >= 0 ? afterHeading + nextMarkdownSection : -1,
    nextReceipt,
  ].filter((index) => index >= 0);
  const receiptEnd = receiptEndCandidates.length ? Math.min(...receiptEndCandidates) : text.length;
  const receiptText = receiptStart >= 0 ? text.slice(receiptStart, receiptEnd) : "";
  const skillApplicationCount = count(
    receiptText,
    /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}Skill application\*{0,2}\s*[:—–-]\*{0,2}/gim,
  );
  const reportedSteps = citedStepTotal(receiptText);
  const updateDispositionPresent = /\bSkill update\*{0,2}\s*[-—–:]/i.test(receiptText)
    || (expectedSteps === 0
      && /Skill application\*{0,2}\s*[:—–-]\*{0,2}\s*(?:`?none`?|no\b)/i.test(receiptText));
  const present = receiptCount > 0;
  const duplicate = receiptCount > 1 || skillApplicationCount > 1;
  const fieldsPresent = /(?:^|\n)\s*[-*]\s*\*{0,2}Root\*{0,2}\s*[:—–-]\*{0,2}/im.test(receiptText)
    && /(?:^|\n)\s*[-*]\s*\*{0,2}Coverage\*{0,2}\s*[:—–-]\*{0,2}/im.test(receiptText)
    && /(?:^|\n)\s*[-*]\s*\*{0,2}Recall\*{0,2}\s*[:—–-]\*{0,2}/im.test(receiptText)
    && skillApplicationCount === 1;
  return {
    present,
    complete: present
      && !duplicate
      && fieldsPresent
      && reportedSteps >= expectedSteps
      && updateDispositionPresent,
    duplicate,
    receiptCount,
    skillApplicationCount,
    expectedSteps,
    reportedSteps,
    updateDispositionPresent,
    receiptText,
  };
}
