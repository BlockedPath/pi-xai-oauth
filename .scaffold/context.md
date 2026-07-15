# Shared Agent Context

**Project:** pi-xai-oauth  
**Branch:** cursor/fix-disable-clears-all-tools-c1c0  
**Date:** 2026-07-15

## Key Context
- Issue #60: `/xai-tools disable` without an active xAI model wiped every authorized network tool.
- Root cause in `setXaiNetworkToolActive`: when `xaiModel` was missing, `nextSelection` started empty and `explicitlyEnabledXaiNetworkTools.delete(scope)` cleared all opt-ins.
- Enable without an xAI model still fails closed with an error (unchanged).
- Lifecycle `syncXaiNetworkToolsForModel` still clears authorization when leaving xAI or on session reset.

## Current Focus
- Selective disable preserves sibling authorizations and registry entries.
- Regression covers enable two tools → disable one with a non-xAI command model → assert the other remains through sync.
