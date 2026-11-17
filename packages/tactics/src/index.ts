/**
 * @pixelworlds/tactics (D-149): what a turn-based tactics game on pixelworld's
 * real cities draws and reads beside the engine's edits and boards (D-124,
 * D-147, D-148): a board's overlay (marks, grid, arrows), voxel models for its units
 * and effects, and how many people a building holds and what it is built of.
 */
export { BoardOverlay, boardOverlay, type Arrow, type BoardOverlayOptions, type Mark, type MarkKind } from "./overlay";
export { FX_KINDS, UNIT_KINDS, entityModel, fxBoxes, rampsFor, unitBoxes, type FxKind, type ModelOptions, type Role, type UnitKind } from "./models";
export { AREA_PER_PERSON, GROUP_RULES, MATERIALS, objectInfo, type GroupRules, type Material, type MaterialProps, type ObjectInfo, type ObjectInfoOptions, type Use } from "./buildings";
export * from "./combat";
export { actionsOf, describePlan, generatePuzzle, greedyTurn, mechanicsOf, playOut, solveTurn, type Action, type Mechanic, type Puzzle, type PuzzleOptions, type Solution, type SolveOptions, type SolveResult } from "./solver";
