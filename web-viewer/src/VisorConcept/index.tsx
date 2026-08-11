import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import ConceptViewer from './App';

let currentRoot: Root | null = null;

/**
 * Mounts the ConceptViewer to a specified DOM element.
 * 
 * @param container The DOM element to render into.
 * @param fileBuffer The binary data of the .concepts file.
 * @param fileName The name of the file being displayed.
 * @param onClose Callback triggered when the user clicks the close (X) button.
 */
export function mountConceptViewer(
  container: HTMLElement, 
  fileBuffer: ArrayBuffer, 
  fileName: string, 
  onClose: () => void
) {
  if (currentRoot) {
    currentRoot.unmount();
  }
  
  currentRoot = createRoot(container);
  
  currentRoot.render(
    <React.StrictMode>
      <ConceptViewer 
        fileBuffer={fileBuffer} 
        fileName={fileName} 
        onClose={() => {
           if (currentRoot) {
             currentRoot.unmount();
             currentRoot = null;
           }
           onClose();
        }} 
      />
    </React.StrictMode>
  );
}

export { ConceptViewer };
