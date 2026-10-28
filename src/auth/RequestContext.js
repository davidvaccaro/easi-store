import { AsyncLocalStorage } from 'node:async_hooks';
import { publicIdentity } from './permissions.js';
const context = new AsyncLocalStorage();
export const withRequestContext = task => context.run({ actor: null }, task);
export function setRequestActor(principal) { const current = context.getStore(); if (current) current.actor = publicIdentity(principal); }
export function requestActor() { return context.getStore()?.actor || null; }
