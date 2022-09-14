﻿varying vec2 vUv;

// precision lowp float;

uniform sampler2D accumulatedTexture;
uniform sampler2D normalTexture;
uniform sampler2D depthTexture;
uniform sampler2D diffuseTexture;
uniform sampler2D envMap;

uniform mat4 projectionMatrix;
uniform mat4 inverseProjectionMatrix;
uniform mat4 cameraMatrixWorld;
uniform float cameraNear;
uniform float cameraFar;

uniform float rayDistance;
uniform float roughnessFade;
uniform float maxRoughness;
uniform float fade;
uniform float thickness;
uniform float ior;
uniform float mip;
uniform float power;
uniform float intensity;
uniform vec2 invTexSize;

uniform float samples;

uniform float jitter;
uniform float jitterRoughness;

#define INVALID_RAY_COORDS vec2(-1.0);
#define EARLY_OUT_COLOR    vec4(0.0, 0.0, 0.0, 1.0)
#define FLOAT_EPSILON      0.00001

float nearMinusFar;
float nearMulFar;
float farMinusNear;

#include <packing>

// helper functions
#include <utils>

vec2 RayMarch(in vec3 dir, inout vec3 hitPos, inout float rayHitDepthDifference);
vec2 BinarySearch(in vec3 dir, inout vec3 hitPos, inout float rayHitDepthDifference);
float fastGetViewZ(const in float depth);
vec3 doSample(vec3 viewPos, vec3 viewDir, vec3 viewNormal, float roughness, float lastFrameAlpha, float sampleCount, vec3 worldPos, float spread, float lod);

void main() {
    vec4 depthTexel = textureLod(depthTexture, vUv, 0.0);

    float depthSize = dot(depthTexel.rgb, depthTexel.rgb);

    // filter out sky
    if (depthSize == 0. || depthSize == 3.) {
        gl_FragColor = EARLY_OUT_COLOR;
        return;
    }

    float unpackedDepth = unpackRGBAToDepth(depthTexel);

    vec4 normalTexel = textureLod(normalTexture, vUv, 0.0);
    float roughness = normalTexel.a;

    if (roughness > maxRoughness || (roughness == 1.0 && roughnessFade == 1.0)) {
        gl_FragColor = EARLY_OUT_COLOR;
        return;
    }

    // pre-calculated variables for the "fastGetViewZ" function
    nearMinusFar = cameraNear - cameraFar;
    nearMulFar = cameraNear * cameraFar;
    farMinusNear = cameraFar - cameraNear;

    normalTexel.rgb = unpackRGBToNormal(normalTexel.rgb);

    // view-space depth
    float depth = fastGetViewZ(unpackedDepth);

    float lastFrameAlpha = textureLod(accumulatedTexture, vUv, 0.0).a;
    vec3 worldPos = screenSpaceToWorldSpace(vUv, unpackedDepth);

    // view-space position of the current texel
    vec3 viewPos = getViewPosition(depth);
    vec3 viewDir = normalize(viewPos);
    vec3 viewNormal = normalTexel.xyz;

    float spread = jitter + roughness * roughness * jitterRoughness;
    spread = min(1.0, spread) * 2.0;

    vec3 SSGI;

    int iterations = spp;

    if (spread < 0.05) {
        iterations = 1;
    } else if (spread > 0.95 && lastFrameAlpha == 1.0) {
        iterations = 1;
    } else if (lastFrameAlpha <= 0.05)
        iterations *= 2;
    else if (lastFrameAlpha == 1.0) {
        iterations = 1;
    }

    vec2 envMapSize = vec2(textureSize(envMap, 0));
    float maxEnvMapSize = max(envMapSize.x, envMapSize.y);
    float maxEnvMapMip = log2(maxEnvMapSize) + 1.0;
    float lod = mip * maxEnvMapMip;

    for (int s = 0; s < iterations; s++) {
        float sF = float(s);
        vec3 sampledSSGI = doSample(viewPos, viewDir, viewNormal, roughness, lastFrameAlpha, sF, worldPos, spread, lod);

        float m = 1. / (sF + 1.0);

        SSGI = mix(SSGI, sampledSSGI, m);
    }

    if (roughnessFade != 0.0) SSGI *= mix(1.0 - roughness, 1.0, max(0.0, 1.0 - roughnessFade));
    if (power != 1.0) SSGI = pow(SSGI, vec3(power));

    SSGI *= intensity;

    gl_FragColor = vec4(SSGI, lastFrameAlpha);
}

vec3 doSample(vec3 viewPos, vec3 viewDir, vec3 viewNormal, float roughness, float lastFrameAlpha, float sampleCount, vec3 worldPos, float spread, float lod) {
    // jittering
    vec3 jitteredNormal = viewNormal;

    if (spread != 0.) {
        float ind = log(samples * float(spp) + sampleCount + 1.0);

        vec3 seed = 1500.0 * ind * worldPos + ind;

        vec2 random = hash23(seed);

        jitteredNormal += spread * getHemisphereSample(viewNormal, random);
        jitteredNormal = normalize(jitteredNormal);
    }

    // source: https://computergraphics.stackexchange.com/a/4994
    float pdf = dot(viewNormal, jitteredNormal) * M_PI;
    if (isnan(pdf)) pdf = 0.0;

    float curIor = mix(ior, 2.33, spread);
    float fresnelFactor = fresnel_dielectric(viewDir, jitteredNormal, curIor);

    vec3 iblRadiance = vec3(0.);

    // view-space reflected ray
    vec3 reflected = normalize(reflect(viewDir, jitteredNormal));

    vec3 dir = normalize(reflected * -viewPos.z);
    dir *= rayDistance / float(steps);

    vec3 hitPos = viewPos;
    float rayHitDepthDifference;

#if steps == 0
    hitPos += dir;

    vec2 coords = viewSpaceToScreenSpace(hitPos);
#else
    vec2 coords = RayMarch(dir, hitPos, rayHitDepthDifference);
#endif

    // invalid ray, use environment lighting as fallback
    if (coords.x == -1.0) {
#ifdef USE_ENVMAP
        // world-space reflected ray
        vec4 reflectedWS = vec4(reflected, 1.) * inverse(cameraMatrixWorld);
        reflectedWS.xyz = normalize(reflectedWS.xyz);

        vec3 sampleDir = reflectedWS.xyz;
        iblRadiance = sampleEquirectEnvMapColor(sampleDir, envMap, lod);

        // we won't deal with calculating direct sun light from the env map as it takes too long to compute and is too noisy
        if (dot(iblRadiance, iblRadiance) > 3.0) iblRadiance = vec3(1.);

        return iblRadiance * pdf * fresnelFactor;
#else
        return vec3(0.);
#endif
    }

    vec2 dCoords = smoothstep(0.2, 0.6, abs(vec2(0.5, 0.5) - coords.xy));
    float ssgiIntensity = clamp(1.0 - (dCoords.x + dCoords.y), 0.0, 1.0);

    vec3 SSGI = textureLod(accumulatedTexture, coords.xy, 0.).rgb * ssgiIntensity * fresnelFactor;

    if (fade != 0.0) {
        vec3 hitWorldPos = screenSpaceToWorldSpace(coords, rayHitDepthDifference);

        // distance from the ssgi point to what it's reflecting
        float ssgiDistance = distance(hitWorldPos, worldPos);

        float opacity = 1.0 / ((ssgiDistance + 1.0) * fade * 0.1);
        if (opacity > 1.0) opacity = 1.0;
        SSGI *= opacity;
    }

    SSGI = min(vec3(1.), SSGI);

    // @TODO: fix very bright spots due to infinite bounces so that we can remove the 0.5 factor
    return SSGI * pdf * 0.5;
}

vec2 RayMarch(in vec3 dir, inout vec3 hitPos, inout float rayHitDepthDifference) {
    float depth;
    float unpackedDepth;
    vec2 uv;

    for (int i = 0; i < steps; i++) {
        hitPos += dir;

        uv = viewSpaceToScreenSpace(hitPos);

        unpackedDepth = unpackRGBAToDepth(textureLod(depthTexture, uv, 0.0));
        depth = fastGetViewZ(unpackedDepth);

        rayHitDepthDifference = depth - hitPos.z;

        if (rayHitDepthDifference >= 0.0 && rayHitDepthDifference < thickness) {
#if refineSteps == 0
            rayHitDepthDifference = unpackedDepth;

            return uv;
#else
            return BinarySearch(dir, hitPos, rayHitDepthDifference);
#endif
        }
    }

#ifndef missedRays
    return INVALID_RAY_COORDS;
#endif

    rayHitDepthDifference = unpackedDepth;

    return uv;
}

vec2 BinarySearch(in vec3 dir, inout vec3 hitPos, inout float rayHitDepthDifference) {
    float depth;
    float unpackedDepth;
    vec4 depthTexel;
    vec2 uv;

    dir *= 0.5;
    hitPos += rayHitDepthDifference > 0.0 ? -dir : dir;

    for (int i = 0; i < refineSteps; i++) {
        uv = viewSpaceToScreenSpace(hitPos);

        unpackedDepth = unpackRGBAToDepth(textureLod(depthTexture, uv, 0.0));
        depth = fastGetViewZ(unpackedDepth);

        rayHitDepthDifference = depth - hitPos.z;

        dir *= 0.5;
        hitPos += rayHitDepthDifference > 0.0 ? -dir : dir;
    }

    uv = viewSpaceToScreenSpace(hitPos);

    rayHitDepthDifference = unpackedDepth;

    return uv;
}

// source: https://github.com/mrdoob/three.js/blob/342946c8392639028da439b6dc0597e58209c696/examples/js/shaders/SAOShader.js#L123
float fastGetViewZ(const in float depth) {
#ifdef PERSPECTIVE_CAMERA
    return nearMulFar / (farMinusNear * depth - cameraFar);
#else
    return depth * nearMinusFar - cameraNear;
#endif
}