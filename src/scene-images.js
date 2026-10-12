import { assertResourceImagesIdle, readResourceReference, saveResourceReference, clearResourceReference, resourceRevision, resourceImageUrl, clearResourceImage, generateResourceImage } from './resource-images.js';

export const assertSceneImagesIdle = (database, ids) => assertResourceImagesIdle('scene', database, ids);
export const readSceneReference = (database, id) => readResourceReference('scene', database, id);
export const saveSceneReference = (database, projectId, id, form) => saveResourceReference('scene', database, projectId, id, form);
export const clearSceneReference = (database, projectId, id, form) => clearResourceReference('scene', database, projectId, id, form);
export const sceneRevision = (scene, project) => resourceRevision('scene', scene, project);
export const sceneImageUrl = (projectId, id, imageId) => resourceImageUrl('scene', projectId, id, imageId);
export const clearSceneImage = (database, projectId, id, form) => clearResourceImage('scene', database, projectId, id, form);
export const generateSceneImage = (database, projectId, id, form) => generateResourceImage('scene', database, projectId, id, form);
