export type Role = 'buyer' | 'provider' | 'admin';
export type Mode = 'fixture' | 'real';
export interface Actor { id:string; email:string; name:string; role:Role; providerId?:string }
export interface CatalogItem { id:string; name:string; description:string; provider:string; profile:string; region:string; cpu:number; memoryGb:number; gpu?:string; durationMinutes:number[]; approved:boolean; organizationId?:string; groupId?:string; providerKeyId?:string }
export interface Requirements { cpu:number; memoryGb:number; gpu?:string }
export interface Receipt { observed:string[]; decision:string; constraints:string[] }
export interface Translation { catalogId:string; region:string; durationMinutes:number; requirements:Requirements }
export interface BidProposal { decision:'bid'|'decline'; totalPriceCents?:number; catalogId?:string; receipt:Receipt }
export interface SupplierPolicy { autoBid:boolean; minimumPriceCents:number; basePriceCents:number; maxPriceCents?:number; allowedCatalogIds?:string[] }
export interface OfferingProposal { catalogId:string; name:string; description:string; priceCents:number }
