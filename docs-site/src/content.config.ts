import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { pilotSchema } from '../schema.mjs';
export const collections = { docs:defineCollection({loader:glob({base:'.generated/docs',pattern:'**/*.md'}),schema:docsSchema({extend:pilotSchema})}) };
