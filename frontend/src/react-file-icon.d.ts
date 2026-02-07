declare module "react-file-icon" {
  import type { ComponentType } from "react";

  export interface FileIconProps {
    extension?: string;
    type?: string;
    color?: string;
    labelColor?: string;
    labelTextColor?: string;
    glyphColor?: string;
    foldColor?: string;
    gradientColor?: string;
    gradientOpacity?: number;
    radius?: number;
    fold?: boolean;
    labelUppercase?: boolean;
    [key: string]: unknown;
  }

  export const FileIcon: ComponentType<FileIconProps>;
  export const defaultStyles: Record<string, Partial<FileIconProps>>;
}
