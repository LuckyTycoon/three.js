﻿import { GLSL3, Matrix4, ShaderMaterial, Uniform, Vector2, Vector3 } from "three"
import vertexShader from "../shader/basic.vert"
import fragmentShader from "../shader/ssgi.frag"
import utils from "../shader/utils.frag"

export class SSGIMaterial extends ShaderMaterial {
	constructor() {
		super({
			type: "SSGIMaterial",

			uniforms: {
				directLightTexture: new Uniform(null),
				accumulatedTexture: new Uniform(null),
				normalTexture: new Uniform(null),
				depthTexture: new Uniform(null),
				diffuseTexture: new Uniform(null),
				emissiveTexture: new Uniform(null),
				velocityTexture: new Uniform(null),
				blueNoiseTexture: new Uniform(null),
				backSideDepthTexture: new Uniform(null),
				envMap: new Uniform(null),
				projectionMatrix: new Uniform(new Matrix4()),
				inverseProjectionMatrix: new Uniform(new Matrix4()),
				cameraMatrixWorld: new Uniform(new Matrix4()),
				viewMatrix: new Uniform(new Matrix4()),
				cameraNear: new Uniform(0),
				cameraFar: new Uniform(0),
				rayDistance: new Uniform(0),
				thickness: new Uniform(0),
				jitter: new Uniform(0),
				jitterRoughness: new Uniform(0),
				r3Offset: new Uniform(new Vector3()),
				frames: new Uniform(0),
				envBlur: new Uniform(0),
				maxRoughness: new Uniform(0),
				maxEnvMapMipLevel: new Uniform(0),
				maxEnvLuminance: new Uniform(0),
				envMapPosition: new Uniform(new Vector3()),
				envMapSize: new Uniform(new Vector3()),
				viewMatrix: new Uniform(new Matrix4()),
				invTexSize: new Uniform(new Vector2()),
				blueNoiseRepeat: new Uniform(new Vector2()),
				envMapSize: new Uniform(new Vector3()),
				cameraPos: new Uniform(new Vector3())
			},

			defines: {
				steps: 20,
				refineSteps: 5,
				spp: 1,
				sunMultiplier: 1,
				CUBEUV_TEXEL_WIDTH: 0,
				CUBEUV_TEXEL_HEIGHT: 0,
				CUBEUV_MAX_MIP: 0,
				vWorldPosition: "worldPos"
			},

			fragmentShader: fragmentShader.replace("#include <utils>", utils),
			vertexShader,

			toneMapped: false,
			depthWrite: false,
			depthTest: false,

			glslVersion: GLSL3
		})
	}
}
