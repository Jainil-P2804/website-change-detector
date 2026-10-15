'use strict';

const { z } = require('zod');
const config = require('../config');

// Selectors end up inside a <style> rule in the render context, so reject anything that could break out of it.
const selector = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((s) => !/[{}<>\n\r]|\/\*/.test(s), 'Invalid characters in selector');

// User regexes run in the worker: bound their size and reject the classic nested-quantifier ReDoS shapes.
// (For hostile multi-tenant deployments, evaluate them with RE2 instead.)
const safeRegex = z
  .string()
  .max(200)
  .refine((r) => {
    try {
      new RegExp(r);
    } catch {
      return false;
    }
    return !/\([^)]*[+*][^)]*\)[+*{]/.test(r);
  }, 'Invalid or potentially unsafe regular expression');

const numberRule = z.object({
  label: z.string().trim().min(1).max(60),
  selector: selector.optional(),
  regex: safeRegex.optional(),
}).refine((r) => r.selector || r.regex, 'A number rule needs a selector or a regex');

const interval = z.number().int().min(config.interval.minMinutes).max(config.interval.maxMinutes);

const targetCreate = z.object({
  url: z.string().url().max(2048),
  name: z.string().trim().min(1).max(120),
  intervalMinutes: interval.default(60),
  sensitivity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  watchSelectors: z.array(selector).max(10).default([]),
  ignoreSelectors: z.array(selector).max(20).default([]),
  keywordsAdded: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  keywordsRemoved: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  numberRules: z.array(numberRule).max(5).default([]),
});

const targetUpdate = targetCreate.partial().extend({ paused: z.boolean().optional() });

const settingsUpdate = z.object({
  mode: z.enum(['INSTANT', 'DAILY_DIGEST']).optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  cooldownMinutes: z.number().int().min(0).max(1440).optional(),
  emailEnabled: z.boolean().optional(),
  telegramBotToken: z.string().max(200).nullable().optional(),
  telegramChatId: z.string().max(100).nullable().optional(),
  discordWebhookUrl: z.string().url().max(500).nullable().optional(),
  genericWebhookUrl: z.string().url().max(500).nullable().optional(),
  aiSummaries: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
});

const extensionAdd = z.object({
  url: z.string().url().max(2048),
  name: z.string().trim().max(120).optional(),
  intervalMinutes: interval.optional(),
});

module.exports = { targetCreate, targetUpdate, settingsUpdate, extensionAdd };
