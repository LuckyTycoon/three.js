﻿import { Matrix4 } from "three"
import { Vector3 } from "three"
import { ShaderMaterial, Uniform, Vector2 } from "three"
import vertexShader from "../../utils/shader/basic.vert"
import fragmentShader from "../shader/temporal_reproject.frag"
import reproject from "../shader/reproject.glsl"

export class TemporalReprojectMaterial extends ShaderMaterial {
	constructor() {
		super({
			type: "TemporalReprojectMaterial",
			uniforms: {
				inputTexture: new Uniform(null),
				accumulatedTexture: new Uniform(null),
				velocityTexture: new Uniform(null),
				hitPositionsTexture: new Uniform(null),
				depthTexture: new Uniform(null),
				lastDepthTexture: new Uniform(null),
				normalTexture: new Uniform(null),
				lastNormalTexture: new Uniform(null),
				blend: new Uniform(0.9),
				constantBlend: new Uniform(false),
				fullAccumulate: new Uniform(false),
				invTexSize: new Uniform(new Vector2()),
				projectionMatrix: new Uniform(new Matrix4()),
				projectionMatrixInverse: new Uniform(new Matrix4()),
				cameraMatrixWorld: new Uniform(new Matrix4()),
				viewMatrix: new Uniform(new Matrix4()),
				prevViewMatrix: new Uniform(new Matrix4()),
				prevCameraMatrixWorld: new Uniform(new Matrix4()),
				cameraPos: new Uniform(new Vector3())
			},
			vertexShader,
			fragmentShader: fragmentShader.replace("#include <reproject>", reproject),
			toneMapped: false
		})
	}
}