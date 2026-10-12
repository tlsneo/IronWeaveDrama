import { assertResourceImagesIdle, readResourceReference, saveResourceReference, clearResourceReference, resourceRevision, resourceImageUrl, clearResourceImage, generateResourceImage } from './resource-images.js';

export const assertCharacterImagesIdle = (database, ids) => assertResourceImagesIdle('character', database, ids);
export const readCharacterReference = (database, id) => readResourceReference('character', database, id);
export const saveCharacterReference = (database, projectId, id, form) => saveResourceReference('character', database, projectId, id, form);
export const clearCharacterReference = (database, projectId, id, form) => clearResourceReference('character', database, projectId, id, form);
export const characterRevision = (character, style) => resourceRevision('character', character, { style });
export const characterBoardUrl = (projectId, id, imageId) => resourceImageUrl('character', projectId, id, imageId);
export const clearCharacterBoard = (database, projectId, id, form) => clearResourceImage('character', database, projectId, id, form);
export const generateCharacterBoard = (database, projectId, id, form) => generateResourceImage('character', database, projectId, id, form);
