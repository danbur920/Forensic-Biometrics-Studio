import html2canvas from "html2canvas";
import { PDFDocument } from "pdf-lib";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/lib/locales/i18n";
import type { TFunction } from "i18next";
import * as PIXI from "pixi.js";
import { drawMarking } from "@/components/pixi/overlays/markings/marking.utils";
import { CANVAS_ID } from "@/components/pixi/canvas/hooks/useCanvasContext";
import { getCanvas } from "@/components/pixi/canvas/hooks/useCanvas";
import { MarkingsStore } from "@/lib/stores/Markings";
import { MarkingTypesStore } from "@/lib/stores/MarkingTypes/MarkingTypes";
import { GlobalSettingsStore } from "@/lib/stores/GlobalSettings";
import { WorkingModeStore } from "@/lib/stores/WorkingMode";
import { WORKING_MODE } from "@/views/selectMode";
import { MarkingClass } from "@/lib/markings/MarkingClass";
import { MarkingType } from "@/lib/markings/MarkingType";
import {
    clamp,
    formatReportDateTime,
    formatBytes,
    getPairedByLabel,
    toBlobBytes,
    toDataUrl,
    md5Bytes,
    md5String,
} from "./report-utils";

type ShoeprintReportGenerationOptions = {
    reportDateTime: string;
    reportLanguage?: string;
    performedBy: string;
    department: string;
    addressLines: string[];
    uniqueColor?: "red" | "green";
    reportTitle?: string;
};

type ImageMeta = {
    name: string;
    width: number;
    height: number;
    sizeBytes: number;
    checksum: string;
    bytes: Uint8Array;
};

type PairedFeature = {
    id: string;
    left: MarkingClass;
    right: MarkingClass;
};

const PAGE = { width: 794, height: 1123, margin: 95 };
const LANDSCAPE = { width: PAGE.height, height: PAGE.width, margin: 70 };
const IMAGE_CELL_SIZE = 200;
const UNIQUE_ROWS_PER_PAGE = 2;
const FULL_CIRCLE = Math.PI * 2;
const CANVAS_CONTEXT_ERROR = "Failed to create canvas context.";

// Prefixes used to classify marking types
const PREFIX_PATTERN = "P:";
const PREFIX_GROUP = "G:";
const PREFIX_UNIQUE = "U:";

const toCssColor = (value: unknown, fallback: string) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        // eslint-disable-next-line no-bitwise
        return `#${(value >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
    }
    if (typeof value === "string" && value.trim().length > 0) return value;
    return fallback;
};

const getSystemId = async () => {
    try {
        const id = await invoke<string>("get_machine_id");
        return id || "unknown";
    } catch {
        return "unknown";
    }
};

const getSpritePath = (sprite: PIXI.Sprite): string | null => {
    // @ts-expect-error custom property
    return (sprite.path as string | null) ?? null;
};

const getImageMeta = async (sprite: PIXI.Sprite): Promise<ImageMeta> => {
    const fullPath = getSpritePath(sprite);
    if (!fullPath) throw new Error("Missing image path for report generation.");
    const bytes = await readFile(fullPath);
    const bitmap = await createImageBitmap(new Blob([toBlobBytes(bytes)]));
    return {
        name: sprite.name ?? "image",
        width: bitmap.width,
        height: bitmap.height,
        sizeBytes: bytes.byteLength,
        checksum: md5Bytes(bytes),
        bytes,
    };
};

const getTypePrefix = (displayName: string): string => {
    const match = displayName.match(/^([A-Z]+):/);
    return match ? `${match[1]}:` : "";
};

const renderImageWithMarkings = async (
    imageBytes: Uint8Array,
    markings: MarkingClass[],
    markingTypes: MarkingType[],
    sizeScale: number,
    options?: { showMarkingLabels?: boolean; markingsAlpha?: number }
) => {
    const bitmap = await createImageBitmap(new Blob([toBlobBytes(imageBytes)]));
    const { width, height } = bitmap;
    const showMarkingLabels = options?.showMarkingLabels ?? true;
    const markingsAlpha = options?.markingsAlpha ?? 1;

    const app = new PIXI.Application({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        preserveDrawingBuffer: true,
    });

    const sprite = new PIXI.Sprite(PIXI.Texture.from(bitmap));
    sprite.position.set(0, 0);
    app.stage.addChild(sprite);

    const g = new PIXI.Graphics();
    g.alpha = markingsAlpha;
    app.stage.addChild(g);

    const scaledTypes = markingTypes.map(type => ({
        ...type,
        size: Math.max(2, type.size * sizeScale),
    }));

    markings.forEach(marking => {
        const type = scaledTypes.find(t => t.id === marking.typeId);
        if (!type) return;
        drawMarking(g, false, marking, type, 1, 1, showMarkingLabels, undefined, 0, width / 2, height / 2);
    });

    const canvas = app.renderer.extract.canvas(app.stage);
    app.destroy(true, { children: true, texture: true, baseTexture: true });
    return canvas as HTMLCanvasElement;
};

const cropCanvas = (
    source: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    size: number
) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(CANVAS_CONTEXT_ERROR);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    const half = size / 2;
    const sx = Math.round(centerX - half);
    const sy = Math.round(centerY - half);
    const srcX = clamp(sx, 0, source.width);
    const srcY = clamp(sy, 0, source.height);
    const dstX = Math.max(0, -sx);
    const dstY = Math.max(0, -sy);
    const srcWidth = Math.max(0, Math.min(source.width - srcX, size - dstX));
    const srcHeight = Math.max(0, Math.min(source.height - srcY, size - dstY));
    if (srcWidth > 0 && srcHeight > 0) {
        ctx.drawImage(source, srcX, srcY, srcWidth, srcHeight, dstX, dstY, srcWidth, srcHeight);
    }
    return canvas;
};

type Side = "top" | "bottom" | "left" | "right";

interface Placement {
    feature: MarkingClass;
    x: number;
    y: number;
    side: Side;
}

interface Bounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

const getFeatureBounds = (
    features: MarkingClass[],
    width: number,
    height: number
): Bounds =>
    features.reduce(
        (acc, f) => ({
            minX: Math.min(acc.minX, f.origin.x),
            maxX: Math.max(acc.maxX, f.origin.x),
            minY: Math.min(acc.minY, f.origin.y),
            maxY: Math.max(acc.maxY, f.origin.y),
        }),
        { minX: width, maxX: 0, minY: height, maxY: 0 }
    );

const determineInitialSide = (angle: number, diagAngle: number): Side => {
    const bias = 0.2;
    if (angle >= -diagAngle + bias && angle < diagAngle - bias) {
        return "right";
    }
    if (angle >= diagAngle - bias && angle < Math.PI - diagAngle + bias) {
        return "bottom";
    }
    if (angle >= -Math.PI + diagAngle - bias && angle < -diagAngle + bias) {
        return "top";
    }
    return "left";
};

const getInitialPlacement = (
    feature: MarkingClass,
    fBounds: Bounds,
    cropX: number,
    cropY: number,
    margin: number,
    imgLeft: number,
    imgTop: number,
    imgRight: number,
    imgBottom: number,
    cropWidth: number,
    cropHeight: number,
    edgeOffset: number
): Placement => {
    const fx = feature.origin.x - cropX + margin;
    const fy = feature.origin.y - cropY + margin;

    const dataCx = margin + (fBounds.minX - cropX + (fBounds.maxX - cropX)) / 2;
    const dataCy = margin + (fBounds.minY - cropY + (fBounds.maxY - cropY)) / 2;

    const centerX = ((imgLeft + imgRight) / 2) * 0.4 + dataCx * 0.6;
    const centerY = ((imgTop + imgBottom) / 2) * 0.4 + dataCy * 0.6;

    const dx = fx - centerX;
    const dy = fy - centerY;
    const angle = Math.atan2(dy, dx);

    const distLeft = fx - imgLeft;
    const distRight = imgRight - fx;
    const distTop = fy - imgTop;
    const distBottom = imgBottom - fy;

    const diagAngle = Math.atan2(cropHeight, cropWidth);
    let side = determineInitialSide(angle, diagAngle);

    const minDist = Math.min(distTop, distBottom, distLeft, distRight);
    const threshold = Math.min(cropWidth, cropHeight) * 0.1;
    if (minDist < threshold) {
        if (minDist === distTop) side = "top";
        else if (minDist === distBottom) side = "bottom";
        else if (minDist === distLeft) side = "left";
        else if (minDist === distRight) side = "right";
    }

    if (side === "top") return { feature, x: fx, y: imgTop - edgeOffset, side };
    if (side === "bottom")
        return { feature, x: fx, y: imgBottom + edgeOffset, side };
    if (side === "left")
        return { feature, x: imgLeft - edgeOffset, y: fy, side };
    return { feature, x: imgRight + edgeOffset, y: fy, side };
};

const applyClustering = (
    placements: Placement[],
    cropWidth: number,
    cropHeight: number,
    cropX: number,
    cropY: number,
    margin: number,
    imgTop: number,
    imgBottom: number,
    imgLeft: number,
    imgRight: number,
    edgeOffset: number
) => {
    const clusterThreshold = Math.min(cropWidth, cropHeight) * 0.05;
    const visited = new Set<MarkingClass>();

    placements.forEach(p => {
        if (visited.has(p.feature)) return;
        const cluster = [p];
        visited.add(p.feature);
        placements.forEach(other => {
            if (visited.has(other.feature)) return;
            const d = Math.hypot(
                p.feature.origin.x - other.feature.origin.x,
                p.feature.origin.y - other.feature.origin.y
            );
            if (d < clusterThreshold) {
                cluster.push(other);
                visited.add(other.feature);
            }
        });

        if (cluster.length > 1) {
            const sideCounts: Record<Side, number> = {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            };
            cluster.forEach(item => {
                const cp = item;
                sideCounts[cp.side] += 1;
            });
            let bestSide: Side = cluster[0]?.side || "top";
            let maxCount = 0;
            (Object.entries(sideCounts) as [Side, number][]).forEach(
                ([s, count]) => {
                    if (count > maxCount) {
                        maxCount = count;
                        bestSide = s;
                    }
                }
            );

            cluster.forEach(item => {
                const cp = item;
                if (cp.side !== bestSide) {
                    cp.side = bestSide;
                    const fx = cp.feature.origin.x - cropX + margin;
                    const fy = cp.feature.origin.y - cropY + margin;
                    if (bestSide === "top") {
                        cp.x = fx;
                        cp.y = imgTop - edgeOffset;
                    } else if (bestSide === "bottom") {
                        cp.x = fx;
                        cp.y = imgBottom + edgeOffset;
                    } else if (bestSide === "left") {
                        cp.x = imgLeft - edgeOffset;
                        cp.y = fy;
                    } else {
                        cp.x = imgRight + edgeOffset;
                        cp.y = fy;
                    }
                }
            });
        }
    });
};

const updatePlacementAfterSideChange = (
    p: Placement,
    targetSide: Side,
    fy: number,
    fx: number,
    imgTop: number,
    imgBottom: number,
    imgLeft: number,
    imgRight: number,
    edgeOffset: number
) => {
    const cp = p;
    cp.side = targetSide;
    if (targetSide === "left") {
        cp.x = imgLeft - edgeOffset;
        cp.y = fy;
    } else if (targetSide === "right") {
        cp.x = imgRight + edgeOffset;
        cp.y = fy;
    } else if (targetSide === "top") {
        cp.y = imgTop - edgeOffset;
        cp.x = fx;
    } else {
        cp.y = imgBottom + edgeOffset;
        cp.x = fx;
    }
};

const tryMovePlacementToBetterSide = (
    p: Placement,
    placements: Placement[],
    cropX: number,
    cropY: number,
    margin: number,
    imgTop: number,
    imgBottom: number,
    imgLeft: number,
    imgRight: number,
    edgeOffset: number
): boolean => {
    const fx = p.feature.origin.x - cropX + margin;
    const fy = p.feature.origin.y - cropY + margin;
    let targetSide: Side = p.side;

    if (p.side === "top" || p.side === "bottom") {
        targetSide = fx - imgLeft < imgRight - fx ? "left" : "right";
    } else {
        targetSide = fy - imgTop < imgBottom - fy ? "top" : "bottom";
    }

    const currentSideCount = placements.filter(p2 => p2.side === p.side).length;
    const targetCount = placements.filter(p2 => p2.side === targetSide).length;

    if (targetCount < currentSideCount - 1) {
        updatePlacementAfterSideChange(
            p,
            targetSide,
            fy,
            fx,
            imgTop,
            imgBottom,
            imgLeft,
            imgRight,
            edgeOffset
        );
        return true;
    }
    return false;
};

const balanceSides = (
    placements: Placement[],
    cropX: number,
    cropY: number,
    margin: number,
    imgTop: number,
    imgBottom: number,
    imgLeft: number,
    imgRight: number,
    edgeOffset: number
) => {
    const sides: Side[] = ["top", "bottom", "left", "right"];
    for (let pass = 0; pass < 3; pass += 1) {
        const totalPoints = placements.length;
        const idealPointsPerSide = totalPoints / 4;
        const slack = 1.5 - pass * 0.2;
        const maxPointsPerSide = Math.max(
            3,
            Math.ceil(idealPointsPerSide * slack)
        );

        sides.forEach(side => {
            const sidePlacements = placements.filter(p => p.side === side);
            if (sidePlacements.length <= maxPointsPerSide) return;

            sidePlacements.sort((a, b) => {
                if (side === "top" || side === "bottom") {
                    return a.feature.origin.x - b.feature.origin.x;
                }
                return a.feature.origin.y - b.feature.origin.y;
            });

            const moveCount = Math.min(
                sidePlacements.length - maxPointsPerSide,
                Math.ceil(sidePlacements.length / 3)
            );

            for (let i = 0; i < moveCount; i += 1) {
                const p =
                    i % 2 === 0
                        ? sidePlacements[0]
                        : sidePlacements[sidePlacements.length - 1];
                if (p) {
                    const moved = tryMovePlacementToBetterSide(
                        p,
                        placements,
                        cropX,
                        cropY,
                        margin,
                        imgTop,
                        imgBottom,
                        imgLeft,
                        imgRight,
                        edgeOffset
                    );
                    if (moved) {
                        sidePlacements.splice(sidePlacements.indexOf(p), 1);
                    }
                }
            }
        });
    }
};

const expandPlacements = (
    sidePlacements: Placement[],
    side: Side,
    availableSize: number,
    expansionFactorLimit: number
) => {
    if (sidePlacements.length === 0) return;

    let firstPos = 0;
    let lastPos = 0;

    const firstItem = sidePlacements[0];
    const lastItem = sidePlacements[sidePlacements.length - 1];

    if (!firstItem || !lastItem) return;

    if (side === "top" || side === "bottom") {
        firstPos = firstItem.x;
        lastPos = lastItem.x;
    } else {
        firstPos = firstItem.y;
        lastPos = lastItem.y;
    }

    const totalDim = lastPos - firstPos;
    if (totalDim < availableSize) {
        const expansionFactor = Math.min(
            expansionFactorLimit,
            availableSize / totalDim
        );
        const center = (firstPos + lastPos) / 2;
        sidePlacements.forEach(p => {
            const cp = p;
            if (side === "top" || side === "bottom") {
                cp.x = center + (cp.x - center) * expansionFactor;
            } else {
                cp.y = center + (cp.y - center) * expansionFactor;
            }
        });
    }
};

const centerAndClampPlacements = (
    sidePlacements: Placement[],
    side: Side,
    cropX: number,
    cropY: number,
    margin: number,
    numberCircleRadius: number,
    canvasWidth: number,
    canvasHeight: number
) => {
    if (sidePlacements.length === 0) return;

    let firstPos = 0;
    let lastPos = 0;

    const firstItem = sidePlacements[0];
    const lastItem = sidePlacements[sidePlacements.length - 1];

    if (!firstItem || !lastItem) return;

    if (side === "top" || side === "bottom") {
        firstPos = firstItem.x;
        lastPos = lastItem.x;
    } else {
        firstPos = firstItem.y;
        lastPos = lastItem.y;
    }

    const currentCenter = (firstPos + lastPos) / 2;
    const idealCenter =
        sidePlacements.reduce((sum, p) => {
            if (side === "top" || side === "bottom") {
                return sum + (p.feature.origin.x - cropX + margin);
            }
            return sum + (p.feature.origin.y - cropY + margin);
        }, 0) / sidePlacements.length;

    const offset = idealCenter - currentCenter;
    sidePlacements.forEach(p => {
        const cp = p;
        if (side === "top" || side === "bottom") {
            cp.x = clamp(
                cp.x + offset,
                numberCircleRadius + 2,
                canvasWidth - numberCircleRadius - 2
            );
        } else {
            cp.y = clamp(
                cp.y + offset,
                numberCircleRadius + 2,
                canvasHeight - numberCircleRadius - 2
            );
        }
    });
};

const resolveInitialGaps = (
    sidePlacements: Placement[],
    side: Side,
    minGap: number
) => {
    sidePlacements.forEach((p, i) => {
        if (i === 0) return;
        const prev = sidePlacements[i - 1];
        const curr = p;
        if (prev && curr) {
            if (side === "top" || side === "bottom") {
                if (curr.x - prev.x < minGap) {
                    curr.x = prev.x + minGap;
                }
            } else if (curr.y - prev.y < minGap) {
                curr.y = prev.y + minGap;
            }
        }
    });
};

const enforceMinimumGaps = (
    sidePlacements: Placement[],
    side: Side,
    minGap: number
) => {
    sidePlacements.forEach((p, i) => {
        if (i === 0) return;
        const p1 = sidePlacements[i - 1];
        const p2 = p;
        if (p1 && p2) {
            if (side === "top" || side === "bottom") {
                if (p2.x < p1.x + minGap * 0.5) {
                    p2.x = p1.x + minGap * 0.5;
                }
            } else if (p2.y < p1.y + minGap * 0.5) {
                p2.y = p1.y + minGap * 0.5;
            }
        }
    });
};

const resolveOverlaps = (
    placements: Placement[],
    side: Side,
    numberCircleRadius: number,
    cropWidth: number,
    cropHeight: number,
    cropX: number,
    cropY: number,
    margin: number,
    canvasWidth: number,
    canvasHeight: number
) => {
    const sidePlacements = placements
        .filter(p => p.side === side)
        .sort((a, b) => {
            if (side === "top" || side === "bottom") {
                return a.feature.origin.x - b.feature.origin.x;
            }
            return a.feature.origin.y - b.feature.origin.y;
        });

    if (sidePlacements.length === 0) return;

    const minGap = numberCircleRadius * 3.0;

    resolveInitialGaps(sidePlacements, side, minGap);

    if (side === "top" || side === "bottom") {
        expandPlacements(sidePlacements, side, cropWidth * 0.95, 1.5);
    } else {
        expandPlacements(sidePlacements, side, cropHeight * 0.95, 1.5);
    }

    centerAndClampPlacements(
        sidePlacements,
        side,
        cropX,
        cropY,
        margin,
        numberCircleRadius,
        canvasWidth,
        canvasHeight
    );

    sidePlacements.sort((a, b) => {
        if (side === "top" || side === "bottom") {
            return a.feature.origin.x - b.feature.origin.x;
        }
        return a.feature.origin.y - b.feature.origin.y;
    });

    enforceMinimumGaps(sidePlacements, side, minGap);
};

const createOverviewCalloutImage = async (
    imageBytes: Uint8Array,
    features: MarkingClass[],
    color: string = "#cc0000"
) => {
    const bitmap = await createImageBitmap(new Blob([toBlobBytes(imageBytes)]));
    const { width, height } = bitmap;

    const numberCircleRadius = Math.max(
        16,
        Math.round(Math.min(width, height) * 0.025)
    );
    const margin = Math.max(
        84,
        Math.round(Math.min(width, height) * 0.22)
    );

    const canvas = document.createElement("canvas");
    canvas.width = width + margin * 2;
    canvas.height = height + margin * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(CANVAS_CONTEXT_ERROR);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, margin, margin);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(margin, margin, width, height);

    if (features.length === 0) return canvas.toDataURL("image/png");

    const fontSize = Math.max(14, Math.round(numberCircleRadius * 1.1));
    ctx.lineWidth = 2.2;
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const imgLeft = margin;
    const imgTop = margin;
    const imgRight = margin + width;
    const imgBottom = margin + height;
    const edgeOffset = numberCircleRadius + 8;

    const featureBounds = getFeatureBounds(features, width, height);

    const placements: Placement[] = features.map(f =>
        getInitialPlacement(
            f,
            featureBounds,
            0,
            0,
            margin,
            imgLeft,
            imgTop,
            imgRight,
            imgBottom,
            width,
            height,
            edgeOffset
        )
    );

    applyClustering(
        placements,
        width,
        height,
        0,
        0,
        margin,
        imgTop,
        imgBottom,
        imgLeft,
        imgRight,
        edgeOffset
    );

    balanceSides(
        placements,
        0,
        0,
        margin,
        imgTop,
        imgBottom,
        imgLeft,
        imgRight,
        edgeOffset
    );

    (["top", "bottom", "left", "right"] as Side[]).forEach(side =>
        resolveOverlaps(
            placements,
            side,
            numberCircleRadius,
            width,
            height,
            0,
            0,
            margin,
            canvas.width,
            canvas.height
        )
    );

    const slotForFeature = new Map<MarkingClass, { x: number; y: number }>();
    placements.forEach(p => {
        slotForFeature.set(p.feature, {
            x: clamp(p.x, numberCircleRadius + 2, canvas.width - numberCircleRadius - 2),
            y: clamp(p.y, numberCircleRadius + 2, canvas.height - numberCircleRadius - 2),
        });
    });

    features.forEach(feature => {
        const slot = slotForFeature.get(feature);
        if (!slot) return;
        const fx = feature.origin.x + margin;
        const fy = feature.origin.y + margin;
        const dx = slot.x - fx;
        const dy = slot.y - fy;
        const length = Math.max(1, Math.hypot(dx, dy));
        const lineEndX = slot.x - (dx / length) * numberCircleRadius;
        const lineEndY = slot.y - (dy / length) * numberCircleRadius;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();
    });

    features.forEach(feature => {
        const slot = slotForFeature.get(feature);
        if (!slot) return;
        ctx.beginPath();
        ctx.fillStyle = "#ffffff";
        ctx.arc(slot.x, slot.y, numberCircleRadius, 0, FULL_CIRCLE);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(String(feature.label), slot.x, slot.y + 0.5);
    });

    return canvas.toDataURL("image/png");
};

const ensureImagesLoaded = async (container: HTMLElement) => {
    const images = Array.from(container.querySelectorAll("img"));
    await Promise.all(
        images.map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise<void>(resolve => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
            });
        })
    );
};

const createPage = () => {
    const page = document.createElement("div");
    page.className = "report-page";
    return page;
};

const createReportRoot = () => {
    const root = document.createElement("div");
    root.className = "report-root";
    return root;
};

const createStyles = () => {
    const style = document.createElement("style");
    style.textContent = `
        .report-root { position: fixed; left: -10000px; top: 0; width: ${PAGE.width}px; }
        .report-page { width: ${PAGE.width}px; height: ${PAGE.height}px; background: #fff; color: #111; font-family: "Arial", sans-serif; padding: ${PAGE.margin}px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; }
        .report-page.landscape { width: ${LANDSCAPE.width}px; height: ${LANDSCAPE.height}px; padding: ${LANDSCAPE.margin}px; }

        .report-title { font-size: 18px; font-weight: 700; text-align: center; margin-bottom: 10px; }
        .meta-row { display: flex; gap: 16px; font-size: 11px; margin-bottom: 2px; }
        .meta-label { font-weight: 700; min-width: 180px; }
        .meta-block { font-size: 11px; margin-top: 6px; margin-bottom: 6px; }
        .section-title { font-size: 11px; font-weight: 700; margin-top: 8px; margin-bottom: 4px; }
        .software-grid { font-size: 11px; display: grid; gap: 2px; }
        .software-row { display: flex; gap: 16px; }
        .software-label { font-weight: 700; min-width: 180px; }
        .input-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 11px; }
        .input-stack { font-size: 11px; margin-bottom: 6px; }
        .input-stack .input-block-title { font-weight: 700; margin-bottom: 2px; }
        .input-block-title { font-weight: 700; margin-bottom: 4px; }
        .input-row { display: flex; gap: 8px; }
        .input-label { font-weight: 700; min-width: 120px; }
        .counts { font-size: 11px; display: flex; gap: 8px; margin-top: 4px; }
        .counts-label { font-weight: 700; }
        .note { font-size: 11px; border-top: 1px solid #ccc; padding-top: 8px; margin-top: auto; }
        .note-title { font-weight: 700; margin-bottom: 2px; }

        .fig-label { font-size: 11px; font-weight: 400; margin-bottom: 4px; }
        .fig { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid #ccc; }
        .fig img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
        .fig-caption { font-size: 11px; font-weight: 700; text-align: center; margin-top: 6px; }

        .category-title { font-size: 14px; font-weight: 700; text-align: center; margin-bottom: 8px; }
        .type-title { font-size: 11px; margin-bottom: 6px; }
        .type-images-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; overflow: hidden; }
        .type-image-col { display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
        .img-label { font-size: 10px; font-weight: 700; text-align: center; }
        .type-image-col .fig { flex: 1; }

        .overview-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; overflow: hidden; align-items: start; }
        .overview-grid .fig { border: none; }

        .table { table-layout: fixed; width: 100%; border-collapse: collapse; font-size: 10px; }
        .table th { border: 1px solid #ccc; padding: 5px 8px; background: #f0f0f0; font-weight: 700; text-align: center; }
        .table td { border: 1px solid #ccc; padding: 4px; vertical-align: middle; text-align: center; overflow: hidden; }
        .table td:first-child { text-align: center; width: 90px; }
        .table td:nth-child(2), .table td:nth-child(3) { width: ${IMAGE_CELL_SIZE}px; }
        .feature-cell { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px 0; }
        .feature-label {
            font-size: 20px; font-weight: 700; color: #c0392b;
            text-align: center; margin: 0 auto;
            display: block;
        }
        .feature-type { font-size: 9px; color: #333; text-align: center; line-height: 1.3; }
        .feature-image { width: ${IMAGE_CELL_SIZE}px; height: ${IMAGE_CELL_SIZE}px; object-fit: cover; border: 1px solid #ddd; display: block; margin: 0 auto; }

        /* Footer */
        .footer { font-size: 9px; display: flex; justify-content: space-between; border-top: 1px solid #eee; padding-top: 4px; margin-top: auto; color: #555; flex-shrink: 0; }
    `;
    return style;
};

type ReportT = TFunction<"report">;

const resolveFeatureTypeName = (
    featureTypeDefinition: MarkingType | undefined,
    tReport: ReportT
) => {
    if (!featureTypeDefinition) return "-";
    const baseName =
        featureTypeDefinition.displayName?.trim() ||
        featureTypeDefinition.name?.trim() ||
        "-";
    return tReport(baseName as never, { defaultValue: baseName });
};

const createFooter = (pageNumber: number, reportId: string, tReport: ReportT) =>
    `<div class="footer"><div>${tReport("Page")} ${pageNumber}</div><div>${tReport("Report ID label")} ${reportId}</div></div>`;

const createFigurePage = (
    caption: string,
    image: string,
    imageLabel: string,
    pageNumber: number,
    reportId: string,
    tReport: ReportT
) => {
    const page = createPage();
    page.innerHTML = `
        <div class="fig-label">${imageLabel}</div>
        <div class="fig"><img src="${image}" /></div>
        <div class="fig-caption">${caption}</div>
        ${createFooter(pageNumber, reportId, tReport)}
    `;
    return page;
};

type GroupedByType = Map<string, { type: MarkingType; pairs: PairedFeature[] }>;

const groupPairedByPrefix = (
    paired: PairedFeature[],
    markingTypes: MarkingType[],
    prefix: string
): GroupedByType => {
    const result: GroupedByType = new Map();
    paired.forEach(pair => {
        const type = markingTypes.find(t => t.id === pair.left.typeId);
        if (!type) return;
        const dn = type.displayName ?? type.name ?? "";
        if (!dn.startsWith(prefix)) return;
        const existing = result.get(type.id);
        if (existing) {
            existing.pairs.push(pair);
        } else {
            result.set(type.id, { type, pairs: [pair] });
        }
    });
    return result;
};

const createCategoryPages = async (
    grouped: GroupedByType,
    leftMeta: ImageMeta,
    rightMeta: ImageMeta,
    markingTypes: MarkingType[],
    categoryTitle: string,
    startPageNumber: number,
    reportId: string,
    tReport: ReportT
): Promise<HTMLElement[]> => {
    const pages: HTMLElement[] = [];
    let pageNumber = startPageNumber;

    for (const { type, pairs } of grouped.values()) {
        const typeName = type.displayName ?? type.name ?? "-";

        const leftMarkings = pairs.map(p => p.left);
        const rightMarkings = pairs.map(p => p.right);

        const [leftCanvas, rightCanvas] = await Promise.all([
            renderImageWithMarkings(leftMeta.bytes, leftMarkings, markingTypes, 1.6, { showMarkingLabels: false, markingsAlpha: 0.75 }),
            renderImageWithMarkings(rightMeta.bytes, rightMarkings, markingTypes, 1.6, { showMarkingLabels: false, markingsAlpha: 0.75 }),
        ]);

        const page = createPage();
        page.innerHTML = `
            <div class="category-title">${categoryTitle}</div>
            <div class="type-title">${tReport("Shoeprint feature type prefix")} ${typeName}</div>
            <div class="type-images-grid">
                <div class="type-image-col">
                    <div class="img-label">${tReport("Image 1")}</div>
                    <div class="fig"><img src="${leftCanvas.toDataURL("image/png")}" /></div>
                </div>
                <div class="type-image-col">
                    <div class="img-label">${tReport("Image 2")}</div>
                    <div class="fig"><img src="${rightCanvas.toDataURL("image/png")}" /></div>
                </div>
            </div>
            ${createFooter(pageNumber, reportId, tReport)}
        `;
        pages.push(page);
        pageNumber += 1;
    }

    return pages;
};

// ─── Main export ──────────────────────────────────────────────────────────────

/* eslint-disable sonarjs/cognitive-complexity */
export const generateShoeprintReportPdfWithDialog = async (
    options: ShoeprintReportGenerationOptions
) => {
    let stage = "init";
    const previousLanguage = i18n.language;
    let languageChanged = false;
    try {
        stage = "check-working-mode";
        const { workingMode } = WorkingModeStore.state;
        if (workingMode !== WORKING_MODE.SHOEPRINT) {
            throw new Error("Report generation is available only for shoeprints.");
        }

        stage = "setup-i18n";
        const reportLanguage =
            options.reportLanguage ||
            GlobalSettingsStore.state.settings.language ||
            i18n.language ||
            "pl";
        if (reportLanguage !== previousLanguage) {
            await i18n.changeLanguage(reportLanguage);
            languageChanged = true;
        }
        await i18n.loadNamespaces(["report", "keywords"]);
        const tReport = i18n.getFixedT(reportLanguage, "report");
        const tKeywords = i18n.getFixedT(reportLanguage, "keywords");

        stage = "get-viewports";
        const leftCanvas = getCanvas(CANVAS_ID.LEFT, true);
        const rightCanvas = getCanvas(CANVAS_ID.RIGHT, true);
        const leftViewport = leftCanvas.viewport;
        const rightViewport = rightCanvas.viewport;
        if (!leftViewport || !rightViewport) throw new Error("Viewports are not ready.");

        stage = "get-sprites";
        const leftSprite = leftViewport.children.find(x => x instanceof PIXI.Sprite) as PIXI.Sprite | undefined;
        const rightSprite = rightViewport.children.find(x => x instanceof PIXI.Sprite) as PIXI.Sprite | undefined;
        if (!leftSprite || !rightSprite) throw new Error("Load both images before generating the report.");

        stage = "collect-markings";
        const markingsLeft = MarkingsStore(CANVAS_ID.LEFT).state.markings;
        const markingsRight = MarkingsStore(CANVAS_ID.RIGHT).state.markings;
        const markingTypes = MarkingTypesStore.state.types;

        const paired = getPairedByLabel(markingsLeft, markingsRight);

        const reportPaired = paired.filter(p => {
            const type = markingTypes.find(t => t.id === p.left.typeId);
            if (!type) return false;
            const dn = type.displayName ?? type.name ?? "";
            const prefix = getTypePrefix(dn);
            return prefix === PREFIX_PATTERN || prefix === PREFIX_GROUP || prefix === PREFIX_UNIQUE;
        });

        const patternGrouped = groupPairedByPrefix(reportPaired, markingTypes, PREFIX_PATTERN);
        const groupGrouped = groupPairedByPrefix(reportPaired, markingTypes, PREFIX_GROUP);
        const uniquePaired = reportPaired.filter(p => {
            const type = markingTypes.find(t => t.id === p.left.typeId);
            const dn = type?.displayName ?? type?.name ?? "";
            return getTypePrefix(dn) === PREFIX_UNIQUE;
        })
        .slice(0, 32); // max 32 unique features per page

        stage = "read-image-meta";
        const leftMeta = await getImageMeta(leftSprite);
        const rightMeta = await getImageMeta(rightSprite);

        stage = "image-data-urls";
        const leftOriginal = await toDataUrl(leftMeta.bytes, leftMeta.name);
        const rightOriginal = await toDataUrl(rightMeta.bytes, rightMeta.name);

        stage = "render-overlays";
        const leftAllCanvas = await renderImageWithMarkings(leftMeta.bytes, markingsLeft, markingTypes, 1.6, { showMarkingLabels: true });
        const rightAllCanvas = await renderImageWithMarkings(rightMeta.bytes, markingsRight, markingTypes, 1.6, { showMarkingLabels: true });

        stage = "unique-crops";
        const uniqueCrops = await Promise.all(
            uniquePaired.map(async feature => {
                // With marking (semi-transparent overlay)
                const [leftWithCanvas, rightWithCanvas] = await Promise.all([
                    renderImageWithMarkings(leftMeta.bytes, [feature.left], markingTypes, 1.6, { showMarkingLabels: false, markingsAlpha: 0.45 }),
                    renderImageWithMarkings(rightMeta.bytes, [feature.right], markingTypes, 1.6, { showMarkingLabels: false, markingsAlpha: 0.45 }),
                ]);
                // Without marking (original)
                const [leftOrigCanvas, rightOrigCanvas] = await Promise.all([
                    renderImageWithMarkings(leftMeta.bytes, [], markingTypes, 1.6),
                    renderImageWithMarkings(rightMeta.bytes, [], markingTypes, 1.6),
                ]);

                const getMarkingCenter = (marking: MarkingClass) => {
                    const withEndpoint = marking as MarkingClass & { endpoint?: { x: number; y: number } };
                    if (withEndpoint.endpoint) {
                        return {
                            x: (marking.origin.x + withEndpoint.endpoint.x) / 2,
                            y: (marking.origin.y + withEndpoint.endpoint.y) / 2,
                        };
                    }
                    return { x: marking.origin.x, y: marking.origin.y };
                };

                const leftCenter = getMarkingCenter(feature.left);
                const rightCenter = getMarkingCenter(feature.right);

                const getMarkingExtent = (marking: MarkingClass): number => {
                    const withEndpoint = marking as MarkingClass & { endpoint?: { x: number; y: number } };
                    if (withEndpoint.endpoint) {
                        const w = Math.abs(withEndpoint.endpoint.x - marking.origin.x);
                        const h = Math.abs(withEndpoint.endpoint.y - marking.origin.y);
                        return Math.max(w, h);
                    }
                    return 20; 
                };

                const leftExtent = getMarkingExtent(feature.left);
                const rightExtent = getMarkingExtent(feature.right);
                const maxExtent = Math.max(leftExtent, rightExtent);
                // Feature should occupy 70% of cell along longer axis
                const targetSize = Math.max(
                    60,
                    Math.min(
                        IMAGE_CELL_SIZE,
                        Math.round(maxExtent / 0.7)
                    )
                );

                const leftWith = cropCanvas(leftWithCanvas, leftCenter.x, leftCenter.y, targetSize);
                const rightWith = cropCanvas(rightWithCanvas, rightCenter.x, rightCenter.y, targetSize);
                const leftOrig = cropCanvas(leftOrigCanvas, leftCenter.x, leftCenter.y, targetSize);
                const rightOrig = cropCanvas(rightOrigCanvas, rightCenter.x, rightCenter.y, targetSize);

                return {
                    leftWith: leftWith.toDataURL("image/png"),
                    rightWith: rightWith.toDataURL("image/png"),
                    leftOrig: leftOrig.toDataURL("image/png"),
                    rightOrig: rightOrig.toDataURL("image/png"),
                };
            })
        );

        stage = "report-metadata";
        const reportSettings = GlobalSettingsStore.state.settings.report;
        const reportDateTime = options.reportDateTime?.trim() || formatReportDateTime(new Date());
        const systemId = await getSystemId();
        const reportIdInput = [
            reportDateTime,
            leftMeta.sizeBytes,
            leftMeta.checksum,
            rightMeta.sizeBytes,
            rightMeta.checksum,
            systemId,
        ].join("|");
        const reportId = md5String(reportIdInput);

        const performedBy = options.performedBy?.trim() || reportSettings?.performedBy || "-";
        const department = options.department?.trim() || reportSettings?.department || "-";
        const addressFallback = [
            reportSettings?.addressLine1,
            reportSettings?.addressLine2,
            reportSettings?.addressLine3,
            reportSettings?.addressLine4,
        ].map(line => line?.trim()).filter(Boolean) as string[];
        const addressLines = options.addressLines?.map(line => line.trim()).filter(Boolean) ?? [];
        const address = addressLines.length > 0 ? addressLines : addressFallback;

        const appVersion = await getVersion();

        stage = "build-dom";
        const root = createReportRoot();
        root.appendChild(createStyles());

        const addressHtml = address.length > 0
            ? address.map(line => `<div>${line}</div>`).join("")
            : "<div>-</div>";

        const page1 = createPage();
        page1.innerHTML = `
        <div class="report-title">${options.reportTitle?.trim() || tReport("Shoeprint report title")}</div>
    
        <div class="meta-block">
            <div class="meta-row"><span class="meta-label">${tReport("Report ID label")}</span><span>${reportId}</span></div>
            <div class="meta-row"><span class="meta-label">${tReport("Report date and time label")}</span><span>${reportDateTime}</span></div>
        </div>
    
        <div class="meta-block">
            <div style="font-weight:700;font-size:11px;margin-bottom:3px;">${tReport("Performed by label")}</div>
            <div style="font-size:11px;">${performedBy}</div>
            <div style="font-size:11px;">${department}</div>
            ${addressHtml}
        </div>
    
        <div class="section-title">${tReport("Software information")}</div>
        <div class="software-grid">
            <div class="software-row"><span class="software-label">${tReport("Application name")}</span><span>Biometrics-Studio</span></div>
            <div class="software-row"><span class="software-label">${tReport("Application version")}</span><span>${appVersion}</span></div>
        </div>
    
        <div class="section-title">${tReport("Input material")}</div>
        <div class="input-stack">
            <div class="input-block-title">${tReport("Image 1")}:</div>
            <div class="input-row"><span class="input-label">${tReport("File name")}</span><span>${leftMeta.name}</span></div>
            <div class="input-row"><span class="input-label">${tReport("Image dimensions")}</span><span>${leftMeta.width} x ${leftMeta.height} px</span></div>
            <div class="input-row"><span class="input-label">${tReport("Size")}</span><span>${formatBytes(leftMeta.sizeBytes)}</span></div>
            <div class="input-row"><span class="input-label">${tReport("Checksum")}</span><span>${leftMeta.checksum}</span></div>
        </div>
        <div class="input-stack">
            <div class="input-block-title">${tReport("Image 2")}:</div>
            <div class="input-row"><span class="input-label">${tReport("File name")}</span><span>${rightMeta.name}</span></div>
            <div class="input-row"><span class="input-label">${tReport("Image dimensions")}</span><span>${rightMeta.width} x ${rightMeta.height} px</span></div>
            <div class="input-row"><span class="input-label">${tReport("Size")}</span><span>${formatBytes(rightMeta.sizeBytes)}</span></div>
            <div class="input-row"><span class="input-label">${tReport("Checksum")}</span><span>${rightMeta.checksum}</span></div>
        </div>

        <div class="counts">
            <div class="input-row"><span class="input-label">${tReport("Matched features count")}</span><span>${reportPaired.length}</span></div>
            <div class="input-row"><span class="input-label">${tReport("Selected features count")}</span><span>${reportPaired.length}</span></div>
        </div>
    
        <div class="note">
            <div class="note-title">${tReport("Note title")}</div>
            <div>${tReport("Note body")}</div>
        </div>
    
        ${createFooter(1, reportId, tReport)}
        `;

        const pages: HTMLElement[] = [page1];

        // Pages 2-5: Fig 1-4
        pages.push(createFigurePage(tReport("Figure 1"), leftOriginal, tReport("Image 1 label"), 2, reportId, tReport));
        pages.push(createFigurePage(tReport("Figure 2"), leftAllCanvas.toDataURL("image/png"), tReport("Image 1 label"), 3, reportId, tReport));
        pages.push(createFigurePage(tReport("Shoeprint figure 3"), rightOriginal, tReport("Image 2 label"), 4, reportId, tReport));
        pages.push(createFigurePage(tReport("Shoeprint figure 4"), rightAllCanvas.toDataURL("image/png"), tReport("Image 2 label"), 5, reportId, tReport));

        // P: pages - one page per type 
        const patternPages = await createCategoryPages(
            patternGrouped,
            leftMeta,
            rightMeta,
            markingTypes,
            tReport("Shoeprint pattern features title"),
            pages.length + 1,
            reportId,
            tReport
        );
        patternPages.forEach(p => pages.push(p));

        // G: pages - one page per type 
        const groupPages = await createCategoryPages(
            groupGrouped,
            leftMeta,
            rightMeta,
            markingTypes,
            tReport("Shoeprint group features title"),
            pages.length + 1,
            reportId,
            tReport
        );
        groupPages.forEach(p => pages.push(p));

        // U: overview page
        if (uniquePaired.length > 0) {
            const calloutColor = options.uniqueColor === "green" ? "#2ecc71" : "#cc0000";
            const leftOverview = await createOverviewCalloutImage(leftMeta.bytes, uniquePaired.map(x => x.left), calloutColor);
            const rightOverview = await createOverviewCalloutImage(rightMeta.bytes, uniquePaired.map(x => x.right), calloutColor);

            const overviewPage = createPage();
            overviewPage.innerHTML = `
                <div class="category-title">${tReport("Shoeprint comparative table overview")}</div>
                <div class="overview-grid">
                    <div class="fig"><img src="${leftOverview}" /></div>
                    <div class="fig"><img src="${rightOverview}" /></div>
                </div>
                ${createFooter(pages.length + 1, reportId, tReport)}
            `;
            pages.push(overviewPage);

            const detailsStartIndex = pages.length;
            uniquePaired.forEach((feature, idx) => {
                const pageIndex = Math.floor(idx / UNIQUE_ROWS_PER_PAGE);
                const targetIndex = detailsStartIndex + pageIndex;
                // eslint-disable-next-line security/detect-object-injection
                if (!pages[targetIndex]) {
                    const page = createPage();
                    page.innerHTML = `
                        <div class="section-title">${tReport("Shoeprint comparative table details")}</div>
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>${tReport("Feature")}</th>
                                    <th>${tReport("Image 1")}</th>
                                    <th>${tReport("Image 2")}</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                        ${createFooter(targetIndex + 1, reportId, tReport)}
                    `;
                    // eslint-disable-next-line security/detect-object-injection
                    pages[targetIndex] = page;
                }

                // eslint-disable-next-line security/detect-object-injection
                const tableBody = pages[targetIndex].querySelector("tbody") as HTMLTableSectionElement | null;
                if (!tableBody) return;

                const featureTypeDefinition = markingTypes.find(t => t.id === feature.left.typeId);
                const featureType = resolveFeatureTypeName(featureTypeDefinition, tReport);
                const markerRing = toCssColor(featureTypeDefinition?.backgroundColor, "#c0392b");
                // eslint-disable-next-line security/detect-object-injection
                const crop = uniqueCrops[idx];
                if (!crop) return;

                // Row 1: with marking overlay
                const row1 = document.createElement("tr");
                row1.innerHTML = `
                    <td rowspan="2">
                        <div class="feature-cell">
                            <div class="feature-label" style="color: ${markerRing};">${feature.left.label}</div>
                            <div class="feature-type">${tReport("Feature type")}:<br/><strong>${featureType}</strong></div>
                        </div>
                    </td>
                    <td><img class="feature-image" src="${crop.leftWith}" /></td>
                    <td><img class="feature-image" src="${crop.rightWith}" /></td>
                `;
                tableBody.appendChild(row1);

                // Row 2: original without marking
                const row2 = document.createElement("tr");
                row2.innerHTML = `
                    <td><img class="feature-image" src="${crop.leftOrig}" /></td>
                    <td><img class="feature-image" src="${crop.rightOrig}" /></td>
                `;
                tableBody.appendChild(row2);
            });
        } else {
            const noUniquePage = createPage();
            noUniquePage.innerHTML = `
                <div class="section-title">${tReport("Shoeprint comparative table overview")}</div>
                <div style="font-size:12px; margin-top: 16px;">${tReport("Shoeprint no unique features")}</div>
                ${createFooter(pages.length + 1, reportId, tReport)}
            `;
            pages.push(noUniquePage);
        }

        pages.forEach(page => root.appendChild(page));
        document.body.appendChild(root);

        try {
            stage = "render-html";
            await ensureImagesLoaded(root);

            stage = "render-pdf";
            const pdf = await PDFDocument.create();
            const renderedPages = await Promise.all(
                pages.map(page => html2canvas(page, { scale: 2, backgroundColor: "#ffffff" }))
            );
            await renderedPages.reduce(
                async (chainPromise, canvas) => {
                    const chain = await chainPromise;
                    const pngBytes = canvas.toDataURL("image/png");
                    const image = await pdf.embedPng(pngBytes);
                    const p = pdf.addPage([canvas.width, canvas.height]);
                    p.drawImage(image, { x: 0, y: 0, width: canvas.width, height: canvas.height });
                    chain.push(p);
                    return chain;
                },
                Promise.resolve([] as ReturnType<typeof pdf.addPage>[])
            );

            stage = "save-pdf";
            const pdfBytes = await pdf.save();
            const filePath = await save({
                title: tKeywords("Generate report"),
                filters: [{ name: "PDF", extensions: ["pdf"] }],
                canCreateDirectories: true,
                defaultPath: `shoeprint-report-${reportId}.pdf`,
            });
            if (!filePath) return;
            await writeFile(filePath, pdfBytes);
        } finally {
            root.remove();
            if (languageChanged) {
                await i18n.changeLanguage(previousLanguage);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`[shoeprint-report] failed at ${stage}: ${message}`, error);
        throw new Error(`Shoeprint report failed at ${stage}: ${message}`);
    }
};
/* eslint-enable sonarjs/cognitive-complexity */
