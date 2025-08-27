import { Route, Routes } from "react-router-dom"
import RealtimeChat from "./components/RealtimeAgent/RealtimeChat"
import Home from "./pages/Home"
import About from "./pages/About"

const App = () => {
  return (
    <>
      <div className='bg-slate-600 text-white'>
        <RealtimeChat />
      </div>

      <Routes>
        <Route path='/' element={<Home />} />
        <Route path='/about' element={<About />} />
      </Routes>

    </>
  )
}

export default App