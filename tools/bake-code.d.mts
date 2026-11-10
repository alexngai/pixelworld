// Types for tools/bake-code.mjs, which the apps' Vite configs import (D-072).
import type { Plugin } from "vite";

export const REPO: string;
export const TOKEN: string;
export const CODE_FILE: string;
export const ROOTS: string[];
export const FILES: string[];
export function bakeCodeIdentity(root?: string, read?: (file: string) => string): { hash: string; files: string[] };
export function bakeCodeHash(root?: string, read?: (file: string) => string): string;
export function bakeCode(options?: { root?: string }): Plugin;
