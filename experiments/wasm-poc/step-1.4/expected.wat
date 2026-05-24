(module
 (type $0 (func (result f32)))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "readGain" (func $readGain))
 (func $readGain (result f32)
  (f32.load
   (i32.const 0)
  )
 )
)
