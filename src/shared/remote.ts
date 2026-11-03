export type RemoteMode='up-to-date'|'fast-forward'|'merge'|'conflict'|'blocked';
export interface RemoteReview {
 token:string;checkedAt:string;expiresAt:string;branch:string;head:string;target:string;
 ahead:number;behind:number;mode:RemoteMode;canApply:boolean;message:string;
 commits:{hash:string;subject:string}[];commitsTruncated:boolean;paths:string[];totalPaths:number;
 resultPaths:string[];totalResultPaths:number;resultAvailable:boolean;
}
export interface RemoteApplied {head:string;mode:'fast-forward'|'merge';message:string}
